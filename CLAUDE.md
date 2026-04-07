# PokerBot

Multi-agent poker system — AI bots play Texas Hold'em on Poker Now (pokernow.com) via WebSocket, with Claude Code as the orchestration layer.

## Architecture Overview

Dual-session design for non-blocking gameplay:

```
Main Session (CC ↔ User) = CoachBot    BotManager (background process)
  - Free conversation anytime             - botmanager.sh polls pending-turns.json
  - Reads state: Read state.json          - claude -p handles each batch
    (pushed by bridge → server)           - Spawns subagents per bot (parallel)
  - GTO coaching with tools               - Writes action.json per bot
  - Executes actions: curl POST /action   - Exits when game.json deleted
  - Game management (start/stop/config)
          ↕ filesystem + HTTP IPC ↕
  coach-bridge.js ──push──▶ coach-server.js (:3456) ──▶ state.json
                  ◀─poll──           ◀─curl── CC
                  /action            POST /action
        orchestrator.js (WebSocket — bots only)
```

## First Run Setup

On first poker-related interaction, check if `setup-status.json` exists:
- **Exists** → Read it, check `available_features`, proceed accordingly.
- **Missing** → Read `SETUP.md` and run the interactive setup flow. Ask user before each install step. Write `setup-status.json` when done.

User can say "重新检查环境" / "re-run setup" / "check dependencies" to re-run setup.

## Key Skills

- `SETUP.md` — First run setup: dependency checks, interactive install, feature availability matrix. **Read this on first run (when setup-status.json doesn't exist).**
- `pokernow-bot/SKILL.md` — Game flow: Enter Room (auto CoachBot), Add Play Bots (anytime), Stop Game. **Read this first when the user wants to play poker.**
- `pokernow-bot/COACH-BRIDGE.md` — Coach bridge connection & API: bridge injection, coach-server endpoints, `__coach` API, setup flow.
- `bot_profiles/CoachBot/personality.md` — CoachBot coaching logic: **GTO Analysis Flow (mandatory)**, range estimation, decision template, coaching style. **Read this when coaching the user.**
- `poker-agent/SKILL.md` — GTO tool manual: each tool's usage, output format, and how to interpret results. **CoachBot MUST load this at session start.**
- `poker-agent/strategy/` — Preflop/postflop/sizing/GTO/range knowledge base. **CoachBot loads all 5 files at session start (see CoachBot Activation below).**
- `pokernow-bot/BOTMANAGER.md` — BotManager background process: `botmanager.sh` + `claude -p` architecture, prompt template, information isolation rules.

## Project Layout

- `bot_profiles/{name}/personality.md` — Bot identity, model, style, habits, **decision workflow** (persistent)
- `bot_profiles/{name}/turn.json` — Current game state when it's this bot's turn (ephemeral)
- `bot_profiles/{name}/action.json` — Bot's decision: written by BotManager (play bots) or CC (CoachBot) (ephemeral)
- `bot_profiles/CoachBot/personality.md` — Observer-only GTO coach (reads user's game via browser bridge, never acts autonomously)
- `pokernow-bot/scripts/orchestrator.js` — Multi-bot WebSocket manager (bots only, CoachBot not included)
- `pokernow-bot/scripts/coach-bridge.js` — Browser-injected CoachBot bridge (hooks page WebSocket, exposes `__coach` API)
- `pokernow-bot/scripts/coach-ws.js` — CoachBot WebSocket direct bridge (no Chrome needed, CLI args)
- `pokernow-bot/scripts/poker-table.jsx` — Visual poker table renderer (CC updates with state data)
- `pokernow-bot/scripts/bridge-live.js` — Single-bot WebSocket bridge (legacy)
- `pokernow-bot/scripts/decide.py` — CLI interface with action validation
- `poker-agent/tools/` — Python calculation tools (equity, odds, hand eval, preflop ranges)

## Critical Rules

### Dual-Session Architecture
Main session (= CoachBot) handles user interaction and coaching. BotManager runs as a background process (`botmanager.sh` + `claude -p`) and handles all play bot decisions autonomously. They communicate via shared JSON files. Never try to run bot decisions in the main session — it blocks user conversation.

### CoachBot Two Modes
CoachBot has two connection modes (see `pokernow-bot/SKILL.md` → CoachBot Activation for details):

**Mode A: Chrome Bridge** (when Claude in Chrome is available)
- Injects `coach-bridge.js` via `javascript_tool` once at game start
- **Read state**: `Read("bot_profiles/CoachBot/state.json")` — preprocessed by coach-server
- **Send action**: `curl -s -X POST localhost:3456/action -H "Content-Type: application/json" -d '{"action":"call"}'`
- **Start server**: `node pokernow-bot/scripts/coach-server.js "gameUrl"` (auto-kills old instance)

**Mode B: WebSocket Direct** (no Chrome needed — fallback or user choice)
- Starts `coach-ws.js` which connects directly via WebSocket
- **Read state**: `Read("bot_profiles/CoachBot/state.json")` — same format
- **Send action**: Write `bot_profiles/CoachBot/action.json` — file-based IPC
- **Render table**: Update `poker-table.jsx` with state data → visual poker table for user
- **Start bridge**: `node pokernow-bot/scripts/coach-ws.js "gameUrl" --name "PlayerName" &`
- **No javascript_tool needed during gameplay** — all communication via HTTP + filesystem

### CoachBot Activation (MANDATORY)
When user mentions ANYTHING poker-coaching related, you ARE CoachBot. Before responding, you MUST load `bot_profiles/CoachBot/personality.md` (if not already loaded this session). Then follow its GTO Analysis Flow.

**Trigger keywords** (non-exhaustive — any poker advice/play intent counts):
- 中文: 怎么打, 该不该call, 该不该raise, 该fold吗, 帮我看看, 帮我分析, 教我打牌, 教我, 来coaching, 这手牌, 分析一下, 打得对吗, 有没有更好的打法, 我打得怎么样, EV多少, 胜率多少, 什么range, 帮我盯着, 替我做决定, GTO怎么说
- English: how to play, should I call/raise/fold, coach me, analyze this hand, what's the EV, what range, is this a good play, help me decide, what would GTO do, review my hand

**First activation each session** → load strategy knowledge, then **welcome the user** (see personality.md → Welcome section):
```python
Read("bot_profiles/CoachBot/personality.md")
Read("poker-agent/SKILL.md")
Read("poker-agent/strategy/preflop.md")
Read("poker-agent/strategy/postflop.md")
Read("poker-agent/strategy/sizing.md")
Read("poker-agent/strategy/gto-fundamentals.md")
Read("poker-agent/strategy/range.md")
# → Then output the Welcome message from personality.md
# → Then handle user's question or wait for game state
```

**Already loaded** → skip welcome, go straight to GTO Analysis Flow in personality.md.

### GTO Tools Are MANDATORY for Coaching
When user asks for poker advice, ALWAYS run the GTO tools before answering. Never give intuition-only advice. See `bot_profiles/CoachBot/personality.md` → "GTO Analysis Flow" for the full mandatory workflow.

### File-Based IPC
The orchestrator and BotManager communicate through JSON files, not stdin/stdout. Never try to pipe commands to the Node process.

### Don't Kill Processes Manually
`bridge-live.js` and `orchestrator.js` auto-kill old instances via PID file on startup. Just start a new instance — don't `taskkill` or `kill` manually.

### Information Isolation
BotManager must inline all game data into subagent prompts as plain text. Subagent prompts must contain NO file paths, NO directory names, NO other bot names. Subagents should have zero knowledge of the project filesystem. CoachBot sees user's cards (via browser bridge) but this never enters any bot's prompt. Future option: per-bot AES encryption on turn.json/state.json/history.jsonl if prompt isolation proves insufficient.

### Action Format
Actions are JSON objects: `{"action": "fold"}`, `{"action": "raise", "amount": 200}`, `{"action": "chat", "message": "gg"}`. Use `decide.py` for validation or validate against the rules in `pokernow-bot/SKILL.md`.

### Turn Timeout
Orchestrator auto check/folds after 60 seconds if no `action.json` is written. Don't spend too long reasoning. (CoachBot is not in orchestrator — no timeout applies.)

### Game End Signal
Deleting `game.json` signals the BotManager to exit. Always delete game.json when stopping a game — orchestrator and BotManager both detect deletion and exit.

## Common User Requests

| User says | What to do |
|-----------|------------|
| "来一局poker" / "play poker" | Read `pokernow-bot/SKILL.md` → Enter Room (auto CoachBot) → ask if add bots |
| "加入 <pokernow link>" / "join this game" | Read `pokernow-bot/SKILL.md` → Enter Room Path B (auto CoachBot) → ask if add bots |
| "加几个bot" / "add bots" (mid-game) | Read `pokernow-bot/SKILL.md` → Add Play Bots flow (orchestrator + BotManager) |
| "建一个新bot" / "create a bot" | Read `.template/personality.md` → create `bot_profiles/{name}/personality.md` → if mid-game, follow Add Play Bots in `pokernow-bot/SKILL.md` to join |
| "结束游戏" / "stop game" | Delete game.json + stop coach-server → everything auto-exits → confirm |
| "别给我建议了" | Toggle off auto-advice; only analyze when user asks |
| Any poker advice keyword (see trigger list) | Activate CoachBot if not already loaded, run GTO Analysis Flow |
| "重新检查环境" / "re-run setup" / "check dependencies" | Read `SETUP.md` → re-run all checks → update `setup-status.json` |
