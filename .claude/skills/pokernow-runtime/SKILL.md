---
name: pokernow-runtime
description: >
  PokerBot FALLBACK SKILL — only triggered when user provides a pokernow.com/games/ URL. This is the backup backend; the primary backend is poker-server (self-hosted). Trigger rules are strict: message must contain a pokernow.com link, or user explicitly says "use pokernow" / "join pokernow". Any other case (including "play poker", "开一局") should go through coachbot → poker-server, not this SKILL.
author: EnyanDai
version: 1.0.0
tags:
  - poker
  - pokernow
  - fallback
  - runtime
metadata:
  openclaw:
    requires:
      bins:
        - node
        - npm
---

# Poker Now Runtime — Fallback Backend

**This is the FALLBACK backend.** The primary way to play is via `/poker-server` (self-hosted).
Only use pokernow-runtime when poker-server is not an option (e.g., user specifically requests pokernow, or joining someone else's pokernow.com room).

For general architecture, CoachBot docs, GTO tools, and game loop → see `AGENTS.md` (project root).
This file covers **pokernow-specific differences only**.

---

## How Mode 3 Differs from Mode 1

| Aspect | Mode 1 (poker-server) | Mode 3 (pokernow) |
|---|---|---|
| Game server | Self-hosted (:3457) | pokernow.com (remote) |
| Bridge to :3456 | poker-client.js | coach-ws.js |
| Bot communication | BotManager → HTTP direct to :3457 | BotManager → file IPC via orchestrator.js |
| Bot join | `POST :3457/join` | orchestrator.js WebSocket + host approval |
| Cookie/browser | User connects to :3456 directly | User MUST use :3456 — pokernow.com cookie belongs to Node process |

---

## Start / Stop

### Start (bridge + orchestrator)

```bash
bash <SKILL_DIR>/start-pokernow.sh --url "<pokernow-game-url>" --name <UserName>
```

Runs: stop old → install deps (if missing) → bridge(:3456) → orchestrator. Health checks built in.

### Stop (bridge + orchestrator + cleanup)

```bash
bash <SKILL_DIR>/stop-pokernow.sh
```

Kills: orchestrator → deletes `game.json` (signals remaining processes) → bridge(:3456).

### Individual components (manual)

```bash
# Start bridge only
node <SKILL_DIR>/scripts/coach-ws.js "<gameUrl>" --name <UserName> --port 3456 &

# Start orchestrator only
node <SKILL_DIR>/scripts/orchestrator.js &

# Stop orchestrator only
kill $(cat <SKILL_DIR>/orchestrator.pid)
```

Orchestrator connects bots sequentially (3s apart), requests seats, watches for turns.

### BotManager (file-mode polling)

In pokernow mode, BotManager uses file IPC instead of HTTP:

```bash
bash <BOT_MANAGEMENT_SKILL_DIR>/botmanager.sh &
```

See `/bot-management` for BotManager start/stop.

> **Note**: For full game startup/shutdown (+ BotManager + all cleanup), use `start-game.sh` / `stop-game.sh` in project root.

---

## Enter Room (Mode 3 Startup)

CC detects a `pokernow.com/games/` URL → Mode 3.

### Path A: User creates a new pokernow game

1. Tell user: "Open https://www.pokernow.com/start-game, create a room, share the link"
2. User shares link → extract URL (regex: `pokernow\.com/games/\w+`)
3. Ask user's in-game name
4. Start bridge (see Start/Stop above)
5. Wait for bridge ready (health check)
6. **Tell user to approve seat request**: coach-ws.js joins via WebSocket and requests a seat. The user (as host) must approve it in their pokernow.com browser tab.
7. `preview_start("http://localhost:3456")` — open bridged view
8. CronCreate (manual mode) → enter Live Game Loop
9. Ask: "Want to add bots?"

### Path B: User joins an existing pokernow game

1. Extract URL, ask user's name
2. Start bridge (same as Path A)
3. **Tell user to ask host to approve**: user is NOT the host — someone else must approve
4. `preview_start("http://localhost:3456")`, CronCreate, Live Game Loop
5. If adding bots: warn user that the host (not them) must approve bot seats too

### Cookie / Browser Restriction

The user CANNOT open pokernow.com directly to see their cards. The session cookie belongs to the coach-ws.js Node process — the browser has no access to it. The only way to visualize the pokernow game is through `localhost:3456` (the bridge).

The user keeps their pokernow.com browser tab open ONLY for host duties (approving seats, managing the room). All gameplay happens through :3456.

---

## Add Play Bots (pokernow-specific)

In poker-server mode, bots join via `POST :3457/join`. In pokernow mode, bots need WebSocket connections managed by orchestrator.js + file-based IPC.

### Flow

1. **Select bots** — same as `modes.md` (scan `/bot-management → bots/`, show list, user picks)

2. **Init bot sessions** — same as `modes.md` Bot Init Flow (always fresh, no resume)

3. **Write/update game.json**:
   ```json
   {
     "gameUrl": "https://www.pokernow.com/games/pglXXXXXX",
     "bots": ["Shark_Alice", "Fish_Bob"],
     "coach": "CoachBot",
     "autoSeat": true,
     "stack": 1000
   }
   ```
   Mid-game add: append new bot names to `bots` array.

4. **Launch orchestrator** (see Start/Stop above)

5. **Approve bots** — host must approve seat requests in pokernow browser.
   CC monitors state until all bots appear in `players`:
   ```bash
   curl -s localhost:3456/state  # check each bot in players list
   ```

6. **Launch BotManager** (see Start/Stop above)

### File-Based IPC (pokernow bots only)

In pokernow mode, BotManager communicates with orchestrator.js via files (not HTTP):

| File | Direction | Purpose |
|---|---|---|
| `game.json` | CC → orchestrator | Bot config. Delete = stop all bots. |
| `pending-turns.json` | orchestrator → BotManager | Which bots need to act |
| `/bot-management → bots/<name>/turn.json` | orchestrator → BotManager | Current turn state for one bot |
| `/bot-management → bots/<name>/action.json` | BotManager → orchestrator | Bot's decision |

CoachBot does NOT use file IPC — it uses HTTP on :3456 (same as all modes).

### Decision Flow (pokernow bots)

```
orchestrator.js detects bot's turn on pokernow.com
  → writes turn.json to bots/<name>/
  → updates pending-turns.json (count + bot list)
  → BotManager polls pending-turns.json, picks up turn
  → BotManager invokes claude -p (cold-start, file mode)
  → bot reads turn.json, reasons with GTO tools, decides
  → bot writes action.json to bots/<name>/
  → orchestrator.js polls action.json (every 0.5s), consumes it
  → orchestrator.js sends action via WebSocket to pokernow.com
```

Key differences from HTTP mode: no `--resume` (cold-start per turn), no `curl` (file read/write instead), BotManager needs `Read,Write,Edit` permissions (not just `Bash`).

Turn timeout: 120s — if no action.json appears, orchestrator auto-folds.

---

## Component Files

| File | Role |
|------|------|
| `scripts/coach-ws.js` | Bridge pokernow.com → localhost:3456 |
| `scripts/orchestrator.js` | Bot WebSocket manager + file IPC |
| `start-pokernow.sh` | Start bridge + orchestrator (this SKILL's own start script) |
| `stop-pokernow.sh` | Stop bridge + orchestrator + cleanup (this SKILL's own stop script) |
| `lib/poker-now.js` | Pokernow WebSocket protocol client |
| `lib/game-state.js` | State parser |
| `references/protocol.md` | Pokernow WS protocol reference |

## Robustness

- Turn timeout: 60s (auto check/fold, CoachBot exempt)
- Per-bot reconnection: exponential backoff (5s → 60s, 20 attempts)
- Orchestrator crash recovery: CC detects stale heartbeat (>15s) → re-launch → auto-kills old PID

## Dependencies

- `/bot-management` — BotManager for bot turn execution (file IPC mode)
- `/poker-strategy` — bots load strategy docs + GTO tools
- **game.json** — runtime bot configuration (project root)
- **ws**, **node-fetch**, **dotenv** npm packages
