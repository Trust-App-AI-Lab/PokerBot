---
name: pokernow-bot
description: >
  FALLBACK — Connect to Poker Now (pokernow.com) when poker-server is not available.
  Only use when the self-hosted poker-server cannot be used.
  Primary game backend is poker-server/ (sibling directory).
---

# Poker Now Bot — FALLBACK Mode

**⚠️ This is the FALLBACK backend.** The primary way to play is via `poker-server/` (self-hosted).
Only use pokernow-bot when poker-server is not an option (e.g., joining someone else's pokernow.com room).

Claude connects to Poker Now via WebSocket.
Enter a room and CoachBot is automatically ready. Add PlayBots anytime — at game start or mid-game.

## Project Structure

```
PokerBot/
  pokernow-bot/           ← Engine (WebSocket, protocol, game state)
    lib/
      poker-now.js        ← WebSocket client (multi-session capable)
      game-state.js       ← Game state parser
    scripts/
      orchestrator.js     ← Multi-bot manager (reads game.json)
      coach-ws.js         ← CoachBot WebSocket bridge (direct connect)
      bridge-live.js      ← Single-bot bridge (legacy)
      decide.py           ← Python CLI interface
  poker-agent/            ← GTO strategy + tools (shared)
    SKILL.md              ← Tool reference + strategy index
    tools/                ← Equity, preflop, odds, evaluator
    strategy/             ← GTO knowledge base
  bot_profiles/           ← Each bot's identity + runtime files
    .template/            ← Copy to create new bot
    CoachBot/
      personality.md      ← Observer-only coach (opus, GTO, no game actions)
    Shark_Alice/
      personality.md      ← Identity, style, model, strategy
      turn.json           ← Written when it's this bot's turn (ephemeral)
      action.json         ← CC writes decision here (ephemeral)
    ...
  game.json               ← Current game config (ephemeral)
```

---

## Game Flow

```
┌──────────────────────────────────────────────────────┐
│  Enter Room (+ auto CoachBot)  ──── always first     │
│       │                                              │
│       │   CoachBot auto-activates: bridge injection    │
│       │   + server start + strategy knowledge loaded  │
│       │                                              │
│       ├──▶  Add Play Bots  (anytime, start or mid)   │
│       │                                              │
│       └──▶  Stop Game                                │
└──────────────────────────────────────────────────────┘
```

**Common scenarios:**
| User intent | Flow |
|---|---|
| Pure coaching (play with humans) | Enter Room → CoachBot auto-ready → play |
| AI-only spectating | Enter Room → Add Bots → watch |
| Coaching + AI mixed game | Enter Room → Add Bots → play with coaching |
| Add bots mid-game | (already in game) → Add Bots |

---

### Enter Room + CoachBot (always first)

**Pre-check**: Before entering a room, verify setup is complete:
```python
try:
    Read("setup-status.json")
    # Check: node=ok, npm_install=ok required for live game
    # If any missing → Read("SETUP.md") → run missing steps first
except:
    # First run — Read("SETUP.md") → run full setup
    Read("SETUP.md")
```

Entering a game room **automatically activates CoachBot**. CoachBot is always-on — the user can choose to use coaching or not, but the infrastructure is ready.

Two paths depending on whether the user creates a new game or joins an existing one:

#### Path A: Create new game ("play poker")

**⚠️ Prefer poker-server for new games.** Only use pokernow.com if user specifically requests it.

1. **Tell user** — "Open https://www.pokernow.com/start-game in your browser, create a room, then share the link with me"
2. **User creates room** and shares link
3. **Extract game URL** from user's message (regex: `pokernow\.com/games/\w+`)
4. **Ask user's in-game name** — coach-ws.js will join as this name
5. **Activate CoachBot** (see below) — coach-ws.js joins the room via WebSocket and requests a seat
6. **Tell user** — "Approve the seat request in your pokernow browser, then open localhost:3456 to play through the bridged view"
7. **CC asks** — "Want to add bots? How many?" (coaching is already ready)

#### Path B: Join existing game (user provides a link)

User pastes a pokernow link.

1. **Extract game URL** from user's message (regex: `pokernow\.com/games/\w+`)
2. **Ask user's in-game name** — coach-ws.js will join as this name
3. **Activate CoachBot** (see below) — coach-ws.js joins via WebSocket, requests a seat
4. **Tell user** — "Ask the host to approve the seat request, then open localhost:3456 to play"
5. **CC asks** — "Want to add bots?" (coaching is already ready)

**Note**: In Path B, the user is NOT the host. If adding bots, the host (someone else) must approve them. CC should warn the user about this.

#### CoachBot Activation (automatic on Enter Room)

Runs as part of room entry. Uses **WebSocket Direct** mode — connects to pokernow.com via WebSocket, no browser needed.

---

**1. Load CoachBot docs + strategy knowledge**
```python
# Trigger CoachBot Activation (see CLAUDE.md) if not already loaded this session:
Read("bot_profiles/CoachBot/personality.md")     # coaching style, GTO analysis flow
Read("poker-agent/SKILL.md")                     # tool reference
Read("poker-agent/strategy/preflop.md")          # preflop decisions
Read("poker-agent/strategy/postflop.md")         # postflop reasoning
Read("poker-agent/strategy/sizing.md")           # bet sizing theory
Read("poker-agent/strategy/gto-fundamentals.md") # core GTO concepts
Read("poker-agent/strategy/range.md")            # range estimation
```

---

**2. Start coach-ws.js**
```bash
cd PokerBot/pokernow-bot && node scripts/coach-ws.js "gameUrl" --name "PlayerName" --port 3456 &
```
Bridges PokerNow WebSocket → HTTP on `:3456`. Auto-kills old instance via PID file. Provides the same `/state` and `/action` HTTP API as poker-client.js — CC uses the same interface regardless of backend.

**3. CoachBot Ready**

CC operates as CoachBot via the unified `:3456` HTTP API (same as all other modes):
- **Read state**: `curl -s localhost:3456/state` — includes user's cards (`myCards`)
- **Send action**: `curl -s -X POST localhost:3456/action -H "Content-Type: application/json" -d '{"action":"call"}'`
- **No browser extension, no Chrome MCP needed** — pure HTTP API

User can open `http://localhost:3456` in browser for the visual table (poker-table.html, bridged view).

**⚠️ The user CANNOT open pokernow.com directly to see their cards.** The session cookie belongs to the coach-ws.js Node process — the browser has no access to it. The only way to visualize the pokernow game is through localhost:3456 (the bridge). This is different from poker-server mode where the user connects directly.

**Gameplay loop**:
```
CC polls localhost:3456/state (every 2-3s)
  → when isMyTurn == true:
    1. Read state for cards, board, pot, actions
    2. Run GTO analysis (tools + strategy)
    3. Show user: state summary + coaching advice + available actions
    4. User says "call" / "raise 200" / "fold"
    5. CC POSTs /action → coach-ws.js executes via WebSocket
    6. Resume polling until next turn
```

**Note**: coach-ws.js joins the pokernow room as a player (using the user's name). The seat request needs host approval.

---

### Add Play Bots (anytime)

**Trigger**: "add bots" / "let AI play too" / "play poker" (implies bots) / listing bot names
**Prerequisite**: Game room exists (URL known), CoachBot already active (from Enter Room)

Can be invoked **at game start or mid-game**. The flow is the same either way.

#### B0. Load BotManager docs

```python
Read("bot_profiles/BOTMANAGER.md")  # prompt template, isolation rules, IPC files — REQUIRED for bot management
```

#### B1. Select Bots

CC scans `PokerBot/bot_profiles/` directories (excluding CoachBot and .template).
For each bot, read `personality.md` to extract name, model, style for display:

```python
# List available bots for user to choose
for bot_dir in bot_profiles/*:
    Read(f"bot_profiles/{bot_dir}/personality.md")  # extract Name, Model, Style fields
# Present: "Shark_Alice (sonnet, TAG), Fish_Bob (haiku, LP), ..."
```

Ask user: which bots? create new ones?

If user wants a new bot:
```python
Read("bot_profiles/.template/personality.md")  # read template format
# mkdir PokerBot/bot_profiles/NewBotName/
# Write personality.md based on template + user's description
# Set model field (haiku/sonnet/opus) based on desired skill level
```

#### B2. Write/Update game.json

```json
{
  "gameUrl": "https://www.pokernow.com/games/pglXXXXXX",
  "bots": ["Shark_Alice", "Fish_Bob", "Maniac_Charlie"],
  "coach": "CoachBot",
  "autoAdvice": false,
  "autoSeat": true,
  "stack": 1000
}
```

**Fields**:
- `bots` — list of bot profile names to join the game
- `coach` — CoachBot name (browser bridge, always active from Enter Room)
- `autoAdvice` (default: `false`) — `true` = CC proactively analyzes on user's turn; `false` = only when asked
- `autoSeat` — bots auto-request seats on join
- `stack` — default stack size for bots

**Mid-game add**: If game.json already exists, update the `bots` array (append new bot names). Orchestrator detects changes and connects new bots.

#### B3. Launch Orchestrator (if not already running)

```bash
cd PokerBot/pokernow-bot && node scripts/orchestrator.js &
```

Orchestrator connects all bots sequentially (3s apart to avoid rate limits), requests seats, and begins watching for turns. If already running, skip this — orchestrator picks up new bots from game.json.

#### B4. Approve Bots (if user is host)

After orchestrator starts, bots send join requests. The host (user in the pokernow.com browser) must approve them manually.

Tell user: "Bots are requesting seats — please approve their join requests in the browser."

CC monitors game state to confirm when bots are seated:
```
loop (every 3s, until all new bots are seated):
  state = curl -s localhost:3456/state
  for each bot in game.json.bots:
    if bot appears in state.players → "✅ {bot} seated"
```

#### B5. Launch BotManager (if not already running)

```bash
cd PokerBot && bash bot_profiles/botmanager.sh &
```

BotManager runs as a Bash outer loop + `claude -p` per batch of pending turns.
See `BOTMANAGER.md` for the full prompt, script, and rules.

If BotManager is already running (mid-game add), skip — it automatically picks up new bots from pending-turns.json.

---

### Stop Game

**Trigger**: "stop game" / "stop the game" / "end game"

```python
# Delete game.json — this is the ONLY step needed
Delete("PokerBot/game.json")
```

Both orchestrator and BotManager detect deletion and exit gracefully. No manual `kill` needed.

Also stop coach-ws.js if running:
```bash
kill $(cat bot_profiles/CoachBot/coach-ws.pid 2>/dev/null)
```

If no bots were added (CoachBot-only session, no game.json), just stop coach-ws.js.

After stopping, CoachBot offers review (in the user's language — see personality.md language routing):
```
🃏 CoachBot: Game over, all connections closed ✅

Played {N} hands total. Want me to review?
  🅰 Full review (I'll find your biggest leaks)
  🅱 Pick a few hands (I'll list them for you)
  🅲 No thanks, maybe next time
```
- User chooses A → `curl localhost:3456/history` to read session history, walk through all hands, summarize biggest leaks
- User chooses B → `curl localhost:3456/history?sessions` to list sessions, let user pick
- User declines → end session normally

Single-bot legacy mode: `kill $(cat bot_profiles/{botName}/bridge.pid)`.

---

## Dual-Session Architecture

```
┌──────────────────────────────────────────────────┐
│  MAIN SESSION (CC ↔ User) = CoachBot             │
│  - Free conversation — user can chat anytime     │
│  - Reads state via HTTP: curl localhost:3456/state│
│  - Gives GTO advice (auto or on-demand)          │
│  - Executes user's actions: POST :3456/action    │
│  - Game management (add/remove bots, stop game)  │
│                                                  │
│  coach-ws.js — bridges pokernow → :3456 HTTP     │
│                                                  │
│  BotManager (background process)                 │
│  - botmanager.sh: polls pending-turns.json (2s)  │
│  - claude -p: handles each batch of turns        │
│  - Spawns subagents per bot (parallel)           │
│  - Writes action.json per bot (file-based IPC)   │
│  - See BOTMANAGER.md for details                 │
│                     ▲                             │
│                     │ WebSocket                   │
│                     ▼                             │
│  orchestrator.js — manages bot WebSocket conns   │
└──────────────────────────────────────────────────┘
```

**Key difference from poker-server mode**: CoachBot uses the same HTTP API (:3456) in both modes, but BotManager in pokernow mode uses file-based IPC (pending-turns.json → action.json) via orchestrator.js, rather than direct HTTP to server.

**Why dual-session?** CC can only do one thing at a time — if it's running bot decisions, the user can't chat. By splitting:
- **Main session** stays responsive — user chats freely
- **BotManager** handles bot decisions in background — no user interaction needed
- Each `claude -p` invocation is short-lived (one batch of turns) — no context accumulation

**Note**: Dual-session only applies when play bots are active. CoachBot-only mode runs entirely in the main session with no background processes.

## Robustness

Turn timeout: 60s (auto check/fold, CoachBot exempt). Per-bot reconnection with exponential backoff (5s→60s, 20 attempts). Orchestrator crash recovery: CC detects stale heartbeat (>15s) → re-launch → auto-kills old PID.

## Communication Files

**CoachBot** uses HTTP API on `:3456` (served by coach-ws.js) — same as all other modes. No file-based IPC for CoachBot.

**BotManager** uses file-based IPC via orchestrator.js:
- `game.json` — bot config (delete = stop all bots)
- `pending-turns.json` — orchestrator → BotManager (which bots need to act)
- `turn.json` / `action.json` — per-bot ephemeral IPC (orchestrator ↔ BotManager)

See `BOTMANAGER.md` for detailed file tables.
