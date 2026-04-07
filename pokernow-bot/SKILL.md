---
name: pokernow-bot
description: >
  Play Texas Hold'em on Poker Now (pokernow.com) — multi-agent poker system.
  Supports single bot or N-bot games with different AI personalities and models.
  Trigger when user mentions Poker Now, poker bot, 德州扑克, "play poker",
  "来一局", "开一桌", or the PokerBot project.
---

# Poker Now Bot — Multi-Agent Architecture

Claude plays Texas Hold'em LIVE on Poker Now via WebSocket.
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
      coach-bridge.js     ← Browser-injected CoachBot bridge
      coach-server.js     ← HTTP bridge server (:3456)
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
      state.json          ← Live game state (pushed by bridge → server)
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
│       │   CoachBot 自动激活：bridge注入 + server启动  │
│       │   + 策略知识加载 → 随时可以coaching           │
│       │                                              │
│       ├──▶  Add Play Bots  (随时可加，开局或中途)     │
│       │                                              │
│       └──▶  Stop Game                                │
└──────────────────────────────────────────────────────┘
```

**Common scenarios:**
| User intent | Flow |
|---|---|
| 纯coaching（和真人打） | Enter Room → CoachBot auto-ready → play |
| AI互打观赏 | Enter Room → Add Bots → watch |
| coaching + AI混战 | Enter Room → Add Bots → play with coaching |
| 中途加bot | (already in game) → Add Bots |

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

#### Path A: Create new game ("来一局poker" / "play poker")

1. **Open PokerNow** — `tabs_create_mcp()` → `navigate(tabId, "https://www.pokernow.com/start-game")`
2. **User creates room** — tell user: "请在浏览器里填昵称、点 CREATE GAME、选座位入座"
3. **CC waits for room** — poll `tabs_context_mcp()` until URL matches `pokernow.com/games/pglXXXXXX`, extract gameId
4. **Activate CoachBot** (see below)
5. **CC asks** — "要加bot吗？几个？" (coaching is already ready)

#### Path B: Join existing game (user provides a link)

User says: "加入这个房间 https://www.pokernow.com/games/pglXXXXXX" or pastes a link.

1. **Extract game URL** from user's message (regex: `pokernow\.com/games/\w+`)
2. **Open game** — `tabs_create_mcp()` → `navigate(tabId, game_url)`
3. **User takes seat** — tell user: "请在浏览器里填昵称入座"
4. **Activate CoachBot** (see below)
5. **CC asks** — "要加bot吗？" (coaching is already ready)

**Note**: In Path B, the user is NOT the host. If adding bots, the host (someone else) must approve them. CC should warn the user about this.

#### CoachBot Activation (automatic on Enter Room)

Runs as part of room entry. **Two modes** — CC picks based on environment:

| Mode | Requires | How user plays | Best for |
|------|----------|----------------|----------|
| **Chrome Bridge** | Claude in Chrome extension | User plays in PokerNow browser UI, CC coaches alongside | Desktop with Chrome |
| **WebSocket Direct** | Nothing (just Node.js) | CC renders poker table visually, user tells CC actions in chat | Any environment, no Chrome needed |

**Detection logic**: Check `setup-status.json` → if `chrome_extension=ok`, use Chrome Bridge. Otherwise, auto-fall back to WebSocket Direct. User can also force mode: "用终端模式" → WebSocket Direct, "用浏览器" → Chrome Bridge.

---

**1. Load CoachBot docs + strategy knowledge** (both modes)
```python
Read("pokernow-bot/COACH-BRIDGE.md")                 # bridge API, endpoints, action format — REQUIRED for gameplay
# Then trigger CoachBot Activation (see CLAUDE.md) if not already loaded this session:
Read("bot_profiles/CoachBot/personality.md")     # coaching style, GTO analysis flow
Read("poker-agent/SKILL.md")                     # tool reference
Read("poker-agent/strategy/preflop.md")          # preflop decisions
Read("poker-agent/strategy/postflop.md")         # postflop reasoning
Read("poker-agent/strategy/sizing.md")           # bet sizing theory
Read("poker-agent/strategy/gto-fundamentals.md") # core GTO concepts
Read("poker-agent/strategy/range.md")            # range estimation
```

---

##### Mode A: Chrome Bridge (default when Chrome extension available)

**2a. Inject Bridge** (once per game tab)
```python
bridgeCode = Read("pokernow-bot/scripts/coach-bridge.js")
javascript_tool(tabId, bridgeCode)
```
Hooks the page's WebSocket, exposes `window.__coach` API. Only needed once — after injection, all communication is HTTP.

**3a. Start Coach Server**
```bash
cd PokerBot/pokernow-bot && node scripts/coach-server.js "gameUrl" &
```
Auto-kills old instance via PID file. Bridge starts pushing state to server, polling `/action`.

**4a. CoachBot Ready (Chrome mode)**

CC operates as CoachBot in the main session:
- **Read state**: `Read("bot_profiles/CoachBot/state.json")` — instant, preprocessed
- **Send action**: `curl -s -X POST localhost:3456/action -H "Content-Type: application/json" -d '{"action":"call"}'`
- **Check result**: `curl -s localhost:3456/action-result`

See **`COACH-BRIDGE.md`** for full `__coach` API reference, endpoints, autoAdvice toggle.

---

##### Mode B: WebSocket Direct (no Chrome needed)

**2b. Start coach-ws.js**
```bash
cd PokerBot/pokernow-bot && node scripts/coach-ws.js "gameUrl" --name "PlayerName" &
```
Connects directly to PokerNow via WebSocket. Auto-kills old instance via PID file. Writes state.json/turn.json to `bot_profiles/CoachBot/`, reads action.json.

**3b. CoachBot Ready (WebSocket mode)**

CC operates as CoachBot — reads state and renders a visual poker table for the user:
- **Read state**: `Read("bot_profiles/CoachBot/state.json")` — same format as Chrome mode
- **Detect turn**: `Read("bot_profiles/CoachBot/turn.json")` — exists when it's our turn
- **Render table**: Update `poker-table.jsx` with current state data → user sees visual poker table
- **Send action**: Write `bot_profiles/CoachBot/action.json` → `{"action":"call"}` — coach-ws.js picks it up and executes
- **No curl, no coach-server needed** — all communication is file-based

**Gameplay loop (WebSocket mode)**:
```
CC polls state.json (every few seconds or on user prompt)
  → when turn.json appears:
    1. Read turn.json for full state
    2. Run GTO analysis (tools + strategy)
    3. Render poker-table.jsx with current state
    4. Show user: table visual + coaching advice + available actions
    5. User says "call" / "raise 200" / "fold"
    6. CC writes action.json → coach-ws.js executes → turn.json deleted
    7. Wait for next turn
```

**Note**: In WebSocket mode, the user does NOT open PokerNow in browser. CC is the interface. The seat request needs host approval just like a PlayBot joining.

---

### Add Play Bots (anytime)

**Trigger**: "加几个bot" / "让AI也来打" / "来一局poker"(implies bots) / listing bot names
**Prerequisite**: Game room exists (URL known), CoachBot already active (from Enter Room)

Can be invoked **at game start or mid-game**. The flow is the same either way.

#### B0. Load BotManager docs

```python
Read("pokernow-bot/BOTMANAGER.md")  # prompt template, isolation rules, IPC files — REQUIRED for bot management
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

After orchestrator starts, bots send join requests. CoachBot bridge is always active (from Enter Room), so CC can auto-approve:

```
loop (every 3s, until all new bots are seated):
  state = __coach.getState()
  for each player where status == "requestedGameIngress":
    if player.name in game.json.bots:
      → auto approve via __coach.hostAction('approve_player', {playerID, stackChange})
      → tell user: "✅ Shark_Alice 已入座"
    else:
      → ask user: "有个叫 xxx 的人要加入，批准吗？"
```

#### B5. Launch BotManager (if not already running)

```bash
cd PokerBot/pokernow-bot && bash scripts/botmanager.sh &
```

BotManager runs as a Bash outer loop + `claude -p` per batch of pending turns.
See `BOTMANAGER.md` for the full prompt, script, and rules.

If BotManager is already running (mid-game add), skip — it automatically picks up new bots from pending-turns.json.

---

### Stop Game

**Trigger**: "结束游戏" / "stop the game" / "关桌"

```python
# Delete game.json — this is the ONLY step needed
Delete("PokerBot/game.json")
```

Both orchestrator and BotManager detect deletion and exit gracefully. No manual `kill` needed.

Also stop the coach-server:
```bash
kill $(cat pokernow-bot/scripts/coach-server.pid 2>/dev/null)
```

If no bots were added (CoachBot-only session, no game.json), just stop the coach-server.

After stopping, CoachBot offers review:
```
🃏 CoachBot: 游戏已结束，所有连接已断开 ✅

这局一共打了 {N} 手牌，要我帮你复盘吗？
  🅰 全部回顾（我帮你找出最大的 leak）
  🅱 选几手分析（我列出来你挑）
  🅱 不用了，下次再说
```
- User chooses A → Read `bot_profiles/CoachBot/history.jsonl`, filter handResult events, walk through all hands, summarize biggest leaks
- User chooses B → List available hands from history.jsonl, let user pick
- User declines → end session normally

Single-bot legacy mode: `kill $(cat bot_profiles/{botName}/bridge.pid)`.

---

## Dual-Session Architecture

```
┌──────────────────────────────────────────────────┐
│  MAIN SESSION (CC ↔ User) = CoachBot             │
│  - Free conversation — user can chat anytime     │
│  - Browser bridge: reads state via coach-server  │
│  - Gives GTO advice (auto or on-demand)          │
│  - Executes user's actions via curl POST /action │
│  - Game management (add/remove bots, stop game)  │
│                     ▲                             │
│                     │ filesystem IPC              │
│                     ▼                             │
│  BotManager (background process)                 │
│  - botmanager.sh: polls pending-turns.json (2s)  │
│  - claude -p: handles each batch of turns        │
│  - Spawns subagents per bot (parallel)           │
│  - Writes action.json per bot                    │
│  - See BOTMANAGER.md for details                 │
│                     ▲                             │
│                     │ WebSocket                   │
│                     ▼                             │
│  orchestrator.js — manages bot WebSocket conns   │
└──────────────────────────────────────────────────┘
```

**Why dual-session?** CC can only do one thing at a time — if it's running bot decisions, the user can't chat. By splitting:
- **Main session** stays responsive — user chats freely
- **BotManager** handles bot decisions in background — no user interaction needed
- Each `claude -p` invocation is short-lived (one batch of turns) — no context accumulation

**Note**: Dual-session only applies when play bots are active. CoachBot-only mode runs entirely in the main session with no background processes.

## Robustness

Turn timeout: 60s (auto check/fold, CoachBot exempt). Per-bot reconnection with exponential backoff (5s→60s, 20 attempts). Orchestrator crash recovery: CC detects stale heartbeat (>15s) → re-launch → auto-kills old PID.

## Communication Files

See `BOTMANAGER.md` for detailed file tables. Key files: `game.json` (config, delete = stop), `pending-turns.json` (orchestrator → BotManager), `turn.json` / `action.json` (per-bot ephemeral IPC), `state.json` (coach-server → CoachBot).
