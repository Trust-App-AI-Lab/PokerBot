# Poker Server — API Interface

Internal infrastructure doc for the self-hosted poker engine + relay + narrator. Not a skill — this is reference material for humans and for CC when debugging server issues. Normal gameplay goes through `/game` → `start-game.sh`, which delegates here.

## Port Layout

| Port | Component | Used By | Role |
|------|-----------|---------|------|
| **:3456** | poker-client.js (relay) | **CoachBot / CC** | Single invariant — CC always reads/writes through this port, regardless of backend |
| **:3457** | poker-server.js (engine) | **BotManager / host setup** | Direct engine access — bots POST actions, host manages config/start/join |
| **:3460** | narrator.js | **CC (read-only) / browser narrator panel** | Event-driven coach trigger + optional auto-play |

**Rule**: CoachBot only hits :3456. BotManager only hits :3457. Never cross.

---

## Start / Stop

### Start (server + relay only)

```bash
bash <DIR>/start-server.sh --name <PlayerName> [--public]
```

Runs: stop old → install deps (if missing) → server(:3457). Relay + narrator are started separately by `start-game.sh` at the `/game` level.

`--public` binds server to 0.0.0.0 (LAN play). Without it, localhost only.

### Stop (server + relay + narrator)

```bash
bash <DIR>/stop-server.sh
```

Kills: narrator(:3460) → relay(:3456) → server(:3457).

### Individual components (manual)

```bash
# Start server only
node <DIR>/poker-server.js [--public] &
# Health check: curl -s localhost:3457/info

# Start relay only
node <DIR>/poker-client.js ws://localhost:3457 --name <PlayerName> --port 3456 &
# Health check: curl -s localhost:3456/state

# Start narrator only
node <DIR>/narrator.js --relay http://localhost:3456 --port 3460 --lang zh [--auto] &
# Health check: curl -s localhost:3460/mode
```

### Dependency install

```bash
npm install --prefix <DIR>
```

`start-server.sh` auto-installs if `node_modules/` is missing.

> **Note**: For full game startup (server + relay + bots + BotManager + narrator + browser), use `start-game.sh` in `.claude/skills/game/`.

---

## Relay API (:3456) — CoachBot / CC

### GET /state

Current game state from the user's perspective (information-isolated).

```json
{
  "phase": "flop",
  "paused": false,
  "handNumber": 12,
  "pot": 150,
  "communityCards": ["Tc", "7d", "2s"],
  "myCards": ["Ah", "Kh"],
  "myStack": 850,
  "isMyTurn": true,
  "callAmount": 50,
  "minRaise": 100,
  "maxRaise": 850,
  "currentBet": 50,
  "currentActor": "Enyan",
  "dealerSeat": 3,
  "positions": { "Enyan": "BTN", "Shark_Alice": "SB", "Fish_Bob": "BB" },
  "smallBlind": 25,
  "bigBlind": 50,
  "autoStart": true,
  "actions": [
    { "player": "Shark_Alice", "action": "raise", "amount": 100 },
    { "player": "Fish_Bob", "action": "call" }
  ],
  "players": [
    { "name": "Enyan", "seat": 3, "stack": 850, "bet": 0, "folded": false, "allIn": false, "sittingOut": false, "isMe": true, "cards": ["Ah", "Kh"] },
    { "name": "Shark_Alice", "seat": 0, "stack": 900, "bet": 100, "folded": false, "allIn": false, "sittingOut": false },
    { "name": "Fish_Bob", "seat": 1, "stack": 850, "bet": 100, "folded": false, "allIn": false, "sittingOut": false }
  ],
  "timestamp": 1713000000000
}
```

**Key fields**:
- `phase` — `"waiting"` | `"preflop"` | `"flop"` | `"turn"` | `"river"` | `"showdown"`
- `isMyTurn` — whether the user should act
- `myCards` — only the user's hole cards (other players' cards hidden)
- `callAmount` / `minRaise` / `maxRaise` — only present when `isMyTurn=true`
- `players[].cards` — only visible for the user (`isMe: true`); absent for opponents
- `phase: "waiting"` — game not started or between hands

### POST /action

Submit user action. Relay auto-attaches player identity — no `player` field needed.

```bash
curl -s -X POST localhost:3456/action \
  -H "Content-Type: application/json" \
  -d '{"action":"call"}'

curl -s -X POST localhost:3456/action \
  -H "Content-Type: application/json" \
  -d '{"action":"raise","amount":200}'
```

**Valid actions**: `fold` `check` `call` `raise` `bet`
- `raise` / `bet` require `amount` (total bet size, not increment)
- Optional `"chat": "message"` for table talk

**Response**: `{ "ok": true }` or `{ "ok": false, "error": "..." }`

### POST /coach-ask

Ask CoachBot a question. Spawns a serialized `claude -p --resume $COACH_SID` subprocess (FIFO queue inside the relay).

```bash
curl -s -X POST localhost:3456/coach-ask \
  -H "Content-Type: application/json" \
  -d '{"question":"该不该call?"}'
```

Optional fields:
- `silent: true` — skip echoing the question in the browser coach panel (used by narrator)
- `headline: "..."` — if `silent=true`, broadcast a short `role: "system"` line instead

If the pre-warmed coach session is missing (e.g. pre-warm failed or cleared), the relay auto-initializes with `--session-id $COACH_SID` + a canned init prompt and retries once.

#### Action sentinel (panel action routing)

After the subprocess reply is captured, the relay scans the **last non-empty line** for:

```
ACTION=<op> [AMOUNT=<N>]
```

`<op>` ∈ `fold` `check` `call` `raise` `bet`. `AMOUNT` is an integer (absolute total bet for `raise` / `bet`). When matched, the relay:

1. Strips that line from the broadcast content (the user sees the rest of the coaching reply, not the sentinel).
2. Internally forwards `{action, amount?}` to the upstream server over the same WS the browser action buttons use.
3. If upstream rejects the action, broadcasts a `role: "error"` coach message with the server's error text.

No sentinel → no action; the reply is broadcast verbatim. The subprocess CoachBot is responsible for deciding when to emit a sentinel (see `/coachbot` SKILL → "Panel Action Routing"). The relay does not parse semantics — it is a pure last-line regex forwarder.

### GET /history

Hand history (information-isolated, only user-visible data).

```bash
curl -s localhost:3456/history              # all hands, current session
curl -s localhost:3456/history?last=5       # last 5 hands
curl -s localhost:3456/history?sessions     # list available session files
```

**Response**: array of JSONL events `[{ts, type, ...}, ...]`
- Event types: `hand_start` → `action` → `board` → `hand_end`
- `hand_end` contains `results` (winners, amounts) and `shownCards`

### GET /config (proxy)

Proxies to :3457 /config. Returns current game configuration.

---

## Server API (:3457) — BotManager / Host

### GET /state?player=X

State from a specific player's perspective. Same schema as relay /state, but `myCards` shows that player's cards.

```bash
curl -s localhost:3457/state?player=Shark_Alice
```

BotManager uses this to read each bot's view of the game.

### POST /action (player field required)

```bash
curl -s -X POST localhost:3457/action \
  -H "Content-Type: application/json" \
  -d '{"player":"Shark_Alice","action":"call"}'
```

**Difference from :3456**: `player` field is required — server doesn't know connection identity.

### POST /join

Add a player to the table.

```bash
curl -s -X POST localhost:3457/join \
  -H "Content-Type: application/json" \
  -d '{"name":"Shark_Alice"}'
```

**Response**: `{ "ok": true, "seat": 2 }` or `{ "ok": false, "error": "..." }`

### POST /start

Start the game (requires at least 2 seated players).

```bash
curl -s -X POST localhost:3457/start
```

**Response**: `{ "ok": true, "players": 4 }` or `{ "ok": false, "error": "Need at least 2 players" }`

### POST /sit

Re-seat a player who is `sittingOut`.

```bash
curl -s -X POST localhost:3457/sit \
  -H "Content-Type: application/json" \
  -d '{"player":"Fish_Bob"}'
```

### POST /rebuy

Refill a player's stack (defaults to initial stack size).

```bash
curl -s -X POST localhost:3457/rebuy \
  -H "Content-Type: application/json" \
  -d '{"player":"Fish_Bob"}'
```

### GET/POST /config

Read or update game configuration.

```bash
# Read
curl -s localhost:3457/config
# → { "turnTimeout": 180000, "stack": 1000, "smallBlind": 25, "bigBlind": 50 }

# Update
curl -s -X POST localhost:3457/config \
  -H "Content-Type: application/json" \
  -d '{"smallBlind":25,"bigBlind":50,"stack":1000,"turnTimeout":180000}'
# → { "ok": true, "turnTimeout": 180000, "stack": 1000, "smallBlind": 25, "bigBlind": 50 }
```

**Validation**: bigBlind must be > smallBlind, otherwise returns error.

### GET /info

Health check.

```bash
curl -s localhost:3457/info
# → { "players": [...], "handNumber": 12, "phase": "flop", "uptime": 3600 }
```

### GET /history

Global server history (not information-isolated). Same query params as relay.

---

## Narrator API (:3460) — Mode Control

### GET /mode

```bash
curl -s localhost:3460/mode
# → { "mode": "manual", "lang": "zh" }
```

### POST /mode

Switch between manual (CoachBot observes/coaches only) and auto (CoachBot plays for the user).

```bash
curl -s -X POST localhost:3460/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"auto"}'
# → { "ok": true, "mode": "auto" }

curl -s -X POST localhost:3460/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"manual","lang":"en"}'
```

---

## Component Files

| File | Role |
|------|------|
| `poker-server.js` | Game engine + HTTP/WS server (:3457) |
| `poker-client.js` | Universal relay (:3456), bridges any upstream + owns serialized CoachBot spawn queue |
| `narrator.js` | Event-driven coach trigger + auto-play loop (:3460) |
| `start-server.sh` | Start server (this component's start script) |
| `stop-server.sh` | Stop narrator + relay + server |
| `lib/poker-engine.js` | Pure game logic, zero I/O |
| `public/poker-table.html` | Browser UI (served from :3457 and :3456) |

## Dependencies

- **game-data/** — writes state.json and history files
- **ws** npm package — WebSocket support
- Standalone: does not depend on `/poker-strategy`, `/coachbot`, `/bot-management`, or the pokernow adapter.
