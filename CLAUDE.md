# PokerBot

Multi-agent poker system — AI bots with distinct personalities play Texas Hold'em, with Claude Code as the orchestration layer.

## Architecture Overview

Two game backends, three connection modes, one unified relay layer:

```
┌──────────────────────────────────────────────────────┐
│  poker-server (PRIMARY — self-hosted)                │
│  node poker-server/poker-server.js                   │
│    ├── Game engine (deal, bet, showdown, rebuy)       │
│    ├── HTTP :3457 → browser UI (poker-table.html)     │
│    ├── WebSocket → real-time state to browser players │
│    ├── /state, /action, /join, /rebuy, /history,      │
│    │   /config, /sit, /start, /info API               │
│    └── --public → localtunnel for remote players      │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│  BotManager (LLM-POWERED BOTS)                       │
│  botmanager.sh → polls /state every 2s               │
│    └── claude -p per bot turn:                        │
│         ├── GET /state?player=X → see own cards       │
│         ├── Read personality.md + strategy docs        │
│         ├── Agent(model) → LLM decision               │
│         └── POST /action → submit to server           │
│  Bots join via POST /join at game start.              │
│  No WebSocket needed — pure HTTP.                     │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│  poker-client.js (CC's UNIVERSAL RELAY)              │
│  Always runs between CC and any game source.         │
│                                                      │
│  Three connection modes:                             │
│  1. Host:    ws://localhost:3457  (own poker-server)  │
│  2. Join:    ws://friend:3457    (remote server)      │
│  3. Pokernow: via coach-ws.js    (pokernow.com)       │
│                                                      │
│  Always provides:                                    │
│    localhost:3456 → poker-table.html (browser UI)     │
│    localhost:3456/state → CC reads game state          │
│    localhost:3456/action → CC sends actions            │
│    bot_profiles/<name>/history/<ts>.jsonl (auto-written)│
│    bot_profiles/<name>/state.json (always-current)     │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│  pokernow-bot (FALLBACK — connect pokernow.com)      │
│  coach-ws.js bridges pokernow → same :3456 interface  │
│  orchestrator.js manages play bots                    │
│  See pokernow-bot/SKILL.md for details.               │
└──────────────────────────────────────────────────────┘
```

**CC always reads/writes via localhost:3456**, regardless of which backend is running. This is the single invariant.

## Key Skills

- `poker-server/` — **PRIMARY game backend**. Self-hosted Texas Hold'em server. `node poker-server.js` starts HTTP + WebSocket server on :3457. Browser players connect directly. CC connects via poker-client.js.
- `poker-server/poker-client.js` — **CC's universal relay**. Connects upstream to any poker-server (local or remote), serves `localhost:3456` for CC to read/write, writes per-session history to `history/` dir. CC always auto-starts this.
- `bot_profiles/BOTMANAGER.md` — **LLM bot engine**. `botmanager.sh` polls server, `claude -p` makes decisions per bot using personality.md + strategy docs. Pure HTTP (no WebSocket needed for bots).
- `pokernow-bot/SKILL.md` — **FALLBACK** game flow for pokernow.com. `coach-ws.js` bridges pokernow → same `:3456` interface.
- `bot_profiles/CoachBot/personality.md` — CoachBot identity, GTO Analysis Flow, coaching style, rules. **Read this when coaching the user.**
- `bot_profiles/CoachBot/modes.md` — Welcome flow + three modes (Play/Review/Learn). Loaded by personality.md's Required Reading.
- `bot_profiles/CoachBot/live-game.md` — Live game loop, Preview toggle, polling rules. Loaded by personality.md's Required Reading.
- `poker-agent/SKILL.md` — GTO tool manual: each tool's usage, output format, and how to interpret results. **CoachBot MUST load this at session start.**
- `poker-agent/strategy/` — Preflop/postflop/sizing/GTO/range knowledge base. **CoachBot loads all 5 files at session start (see CoachBot Activation below).**

## Project Layout

### poker-server/ (PRIMARY backend)
- `poker-server.js` — Game server (HTTP :3457 + WebSocket). Hosts game, serves browser UI, writes global `history.jsonl`.
- `poker-client.js` — **CC's universal relay**. Connects upstream to any poker-server, serves `:3456` locally for CC, writes per-session history to `history/` dir (information-isolated, rotates at 100 hands).
- (bots connect via HTTP API — no bot-side WebSocket client needed. See BotManager below.)
- `lib/poker-engine.js` — Pure Texas Hold'em engine (deal, bet, showdown, side pots, rebuy). Zero I/O.
- `public/poker-table.html` — Browser UI (join, play, spectate). Export History button for browser-side history download. Works with both `:3457` (direct) and `:3456` (relay).

### bot_profiles/
- `{name}/personality.md` — Bot identity, model, style, habits, **decision workflow** (persistent)
- `{name}/history/<ts>.jsonl` — Per-session hand history, information-isolated (only own cards + showdown). Rotates at 100 hands.
- `{name}/state.json` — Always-current game state (written by poker-client.js)
- `{name}/turn.json` — Current turn info when it's this bot's turn (ephemeral, pokernow mode)
- `{name}/action.json` — Bot's decision (ephemeral, pokernow mode)
- `CoachBot/personality.md` — Observer-only GTO coach (never acts autonomously)
- `BOTMANAGER.md` — BotManager background process architecture

### pokernow-bot/ (FALLBACK)
- `scripts/coach-ws.js` — Bridges pokernow.com → same `:3456` interface as poker-client.js
- `scripts/orchestrator.js` — Multi-bot WebSocket manager for pokernow play bots
- `scripts/decide.py` — CLI interface with action validation

### poker-agent/
- `tools/` — Python GTO calculation tools (equity, odds, hand eval, preflop ranges)
- `strategy/` — 5 strategy knowledge files (preflop, postflop, sizing, gto-fundamentals, range)

## Critical Rules

### Bash 命令规范
- **使用相对路径** — 所有 bash/node 命令必须用相对路径（如 `bash start-game.sh`，不要用 `bash C:/full/path/start-game.sh`），否则不匹配 `.claude/settings.local.json` 的权限规则，用户会被反复弹窗确认。
- **单一命令** — 每次 Bash 调用只执行一条命令，不要用 `&&`、`&`、`;`、`|` 串联多条命令。需要多条命令时分开调用。

### Dual-Session Architecture
Main session (= CoachBot) handles user interaction and coaching. BotManager runs as a background process (`bot_profiles/botmanager.sh` + `claude -p`) and handles all play bot decisions autonomously. In poker-server mode, BotManager communicates directly via HTTP API (no intermediate files needed). In pokernow fallback mode, they communicate via shared JSON files. Never try to run bot decisions in the main session — it blocks user conversation.

### CoachBot Connection (ALL modes)
CC always connects through a relay layer on **localhost:3456**. This is the single invariant across all game modes.

**CoachBot = user's proxy.** The relay joins the game server using the **user's name**, not "CoachBot". CoachBot is not a separate player — it's the user's coaching layer that reads the same relay state. The user plays through :3456, and CC (as CoachBot) reads :3456/state to see the user's cards.

```
User browser → :3456 (relay, name=UserName) → :3457 (server)
                 ↑
           CoachBot reads /state here
           sees user's cards (same identity)
           history: bot_profiles/<UserName>/history.jsonl
```

CC auto-starts the appropriate relay. **Ask user for their in-game name before starting.**

**Mode 1 — Host own game (poker-server):**
```bash
# CC starts these automatically:
node poker-server/poker-server.js &                              # game server on :3457
node poker-server/poker-client.js ws://localhost:3457 --name <UserName> --port 3456 &  # relay on :3456

# CC uses preview_start to show http://localhost:3456 (NOT :3457)
# CC reads/writes via http://localhost:3456/state (sees user's cards)

# Join bots via HTTP (one per bot profile):
curl -s -X POST localhost:3457/join -H "Content-Type: application/json" -d '{"name":"Shark_Alice"}'
curl -s -X POST localhost:3457/join -H "Content-Type: application/json" -d '{"name":"Fish_Bob"}'
# ... repeat for each bot

# Start BotManager (LLM decisions for all bots):
bash bot_profiles/botmanager.sh &
```

**Mode 2 — Join remote game (someone else's poker-server):**
```bash
# CC starts this automatically (user provides the server URL):
node poker-server/poker-client.js ws://friend:3457 --name <UserName> --port 3456 &
# CC uses preview_start to show http://localhost:3456 (relayed view)
# CC reads/writes via http://localhost:3456
```

**Mode 3 — Join pokernow.com (fallback):**
```bash
# CC starts this automatically (user provides pokernow link):
node pokernow-bot/scripts/coach-ws.js "https://pokernow.com/games/xxx" --name <UserName> --port 3456 &
# User MUST open http://localhost:3456 (bridged view) — NOT pokernow.com directly
# (session cookie belongs to coach-ws.js process, browser can't access it)
# CC reads/writes via http://localhost:3456
```

**Mode 4 — Text Mode (zero dependencies):**
```
# No server, no browser. CoachBot is dealer + AI opponents, all in CC chat.
# User types actions directly: "call", "raise 200", "fold"
# CoachBot uses GTO tools for AI decisions + coaching.
# See personality.md → "1D — Text Mode" for full flow.
```

**CC is the primary user interface (Modes 1-3).** Browser (poker-table.html) is a fully playable UI — users can also click Fold/Check/Call/Raise/All-in buttons directly. However, CC (CoachBot) is the recommended interface because it provides GTO coaching alongside every decision. CoachBot polls `/state`, renders text narration in CC, executes actions, and gives GTO advice — all in one place. See `personality.md` → "Live Game Loop" for the full flow.

**CC always uses the same API regardless of mode (Modes 1-3):**
- **Read state**: `curl -s localhost:3456/state` — includes user's cards (`myCards`)
- **Send action**: `curl -s -X POST localhost:3456/action -H "Content-Type: application/json" -d '{"action":"call"}'`
- **Poll loop**: After executing an action, poll `/state` every 2-3s until it's user's turn again, rendering updates in CC chat
- **History**: `curl -s localhost:3456/history?sessions` to list sessions, `curl -s localhost:3456/history` for current session, `curl -s localhost:3456/history?last=5` for last 5 hands
- **Config** (host mode only, direct to :3457): `GET /config` to read, `POST /config {"turnTimeout":180000, "smallBlind":25, "bigBlind":50, "stack":1000}` to update
- **Game control** (host mode only, direct to :3457): `POST /start` to begin game, `POST /sit {"player":"name"}` to sit player back in, `GET /info` for server info
- **No browser extension, no Chrome MCP needed** — pure HTTP API
- **Mode 4 (Text)**: No API — state is maintained in conversation context, actions via chat text

### CoachBot Activation (MANDATORY)
When user mentions ANYTHING poker-coaching related, you ARE CoachBot. Before responding, you MUST load `bot_profiles/CoachBot/personality.md` (if not already loaded this session). Then follow its GTO Analysis Flow.

**Trigger keywords** (non-exhaustive — any poker advice/play intent counts):
- 中文: 怎么打, 该不该call, 该不该raise, 该fold吗, 帮我看看, 帮我分析, 教我打牌, 教我, 来coaching, 这手牌, 分析一下, 打得对吗, 有没有更好的打法, 我打得怎么样, EV多少, 胜率多少, 什么range, 帮我盯着, 替我做决定, GTO怎么说
- English: how to play, should I call/raise/fold, coach me, analyze this hand, what's the EV, what range, is this a good play, help me decide, what would GTO do, review my hand, let's play poker, start a game, play poker

**Language**: CoachBot is bilingual (Chinese + English). It auto-detects the user's language from their most recent message and responds in that language. See `personality.md` → "语言路由" for detailed rules.

**⚠️ CRITICAL language rule**: When the user speaks Chinese, CoachBot MUST respond entirely in Chinese (with only standard poker terms in English — fold, call, raise, equity, etc.). The fact that internal documentation is written in English does NOT mean CoachBot should output English to Chinese-speaking users. Chinese input → Chinese output, always, no exceptions.

**First activation each session** → load strategy knowledge, then **welcome the user** (see modes.md → Welcome — choose language based on user's message):
```python
Read("bot_profiles/CoachBot/personality.md")
Read("poker-agent/SKILL.md")
Read("poker-agent/strategy/preflop.md")
Read("poker-agent/strategy/postflop.md")
Read("poker-agent/strategy/sizing.md")
Read("poker-agent/strategy/gto-fundamentals.md")
Read("poker-agent/strategy/range.md")
# → Then welcome the user (in their language)
# → Then handle user's question or wait for game state
# → For live games: curl localhost:3456/state to read game state (always :3456)
```

**Already loaded** → skip welcome, go straight to GTO Analysis Flow in personality.md.

### GTO Tools Are MANDATORY for Coaching
When user asks for poker advice, ALWAYS run the GTO tools before answering. Never give intuition-only advice. See `bot_profiles/CoachBot/personality.md` → "GTO Analysis Flow" for the full mandatory workflow.

### File-Based IPC
The orchestrator and BotManager communicate through JSON files, not stdin/stdout. Never try to pipe commands to the Node process.

### Don't Kill Processes Manually
`orchestrator.js` auto-kills old instances via PID file on startup. Just start a new instance — don't `taskkill` or `kill` manually.

### Information Isolation
BotManager must inline all game data into subagent prompts as plain text. Subagent prompts must contain NO file paths, NO directory names, NO other bot names. Subagents should have zero knowledge of the project filesystem. CoachBot sees user's cards (via relay — same identity, no server API hack needed) but this never enters any bot's prompt. Future option: per-bot AES encryption on turn.json/state.json/history.jsonl if prompt isolation proves insufficient.

### Action Format
- **Via relay (:3456)**: `{"action": "fold"}`, `{"action": "raise", "amount": 200}`, `{"action": "chat", "message": "gg"}` — no player field needed, relay knows identity.
- **Direct to server (:3457, used by BotManager)**: `{"player": "Shark_Alice", "action": "call"}` — player field required.
- Use `decide.py` for validation or validate against the rules in `pokernow-bot/SKILL.md`.

### Turn Timeout
- **poker-server mode**: Server auto check/folds after 180 seconds (3 minutes, configurable via `POST /config {"turnTimeout": ms}`). Applies to all players including bots.
- **pokernow fallback**: Orchestrator auto check/folds after 60 seconds if no `action.json` is written.
- CoachBot is not subject to timeout — it's the user's proxy, not a separate player.

### Game End Signal
- **poker-server mode**: Stop the server process → BotManager detects curl failure and exits.
- **pokernow fallback**: Delete `game.json` → orchestrator and BotManager both detect deletion and exit.

## History Format

Unified event-based JSONL format used by all writers (poker-server, poker-client, coach-ws, orchestrator):

```jsonl
{"ts":"2026-04-08T...","type":"hand_start","hand":1,"blinds":[25,50],"positions":{"Alice":"BTN","Bob":"BB"},"players":{"Alice":[["Ah","Kd"],1000],"Bob":[[],1000]}}
{"ts":"2026-04-08T...","type":"action","hand":1,"action":"Alice raise 150"}
{"ts":"2026-04-08T...","type":"board","hand":1,"cards":["Tc","3h","Ks"]}
{"ts":"2026-04-08T...","type":"hand_end","hand":1,"results":["Alice 200 Pair"],"shown":["Alice"],"stacks":{"Alice":1200,"Bob":800}}
```

- **Server** (`poker-server/history.jsonl`): full truth — all players' cards visible. Admin/spectator view.
- **Per-player** (`bot_profiles/<name>/history/<ts>.jsonl`): information-isolated — only own cards + showdown cards. Written by poker-client.js (per-session files, rotates at 100 hands). API: `GET /history?sessions` to list, `GET /history?session=<file>` to read specific session.
- **Browser**: in-memory `handHistory[]`, exportable via Export History button in poker-table.html.
- Action names are full words (call/check/bet/raise/fold) except sb/bb stay abbreviated.
- `ts` (ISO timestamp) is always the first field in each JSON line.

## Common User Requests

| User says | What to do |
|-----------|------------|
| "来一局poker" / "play poker" / "实战" | Ask game mode (server/text) → Mode 1 or Mode 4 |
| "纯文字打牌" / "text mode" / "不用浏览器" | Text Mode (Mode 4) → CoachBot deals in chat, zero dependencies |
| "教学" / "teach me" / "教我打牌" / "练习" / "practice" | Local bot game with proactive coaching — Mode 1 + BotManager + higher coaching intensity |
| "加入 <IP/URL>" / "join 192.168.1.5" / "join this server" | Detect it's a poker-server address → `poker-client.js ws://<addr>:3457` (Mode 2) → CC coaches via `:3456` |
| "加入 <pokernow link>" / "join pokernow.com/games/xxx" | Detect it's a pokernow URL → `coach-ws.js` (Mode 3) → CC coaches via `:3456` |
| "加几个bot" / "add bots" | `curl POST /join` for each bot profile → start BotManager (`bash botmanager.sh &`) if not running |
| "建一个新bot" / "create a bot" | Read `.template/personality.md` → create `bot_profiles/{name}/personality.md` → if mid-game, `curl POST /join` to add |
| "结束游戏" / "stop game" | Stop poker-server + poker-client.js processes → confirm |
| "别给我建议了" / "stop giving advice" | Toggle off auto-advice; only analyze when user asks |
| "关掉预览" / "no preview" | Stop poker-client.js relay, no browser UI — CC polls upstream directly, lighter resource usage |
| "打开预览" / "open preview" | Start relay, CC uses `preview_start` to show :3456 |
| Any poker advice keyword (see trigger list) | Activate CoachBot if not already loaded, run GTO Analysis Flow |
| "重新检查环境" / "re-run setup" / "check dependencies" | Read `SETUP.md` → run dependency checks |
| "开公网" / "public game" | `node poker-server.js --public` → localtunnel URL for remote players |
| "回顾牌局" / "review hands" / "analyze history" | `curl localhost:3456/history?sessions` → list sessions → user picks one → read that session |
