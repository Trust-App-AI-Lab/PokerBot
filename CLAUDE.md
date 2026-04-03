# PokerBot

Multi-agent poker system — AI bots play Texas Hold'em on Poker Now (pokernow.com) via WebSocket, with Claude Code as the orchestration layer.

## Key Skills

- `pokernow-bot/SKILL.md` — Multi-bot game flow: how to launch, manage turns, create bots, stop games. **Read this first when the user wants to play poker.**
- `poker-agent/SKILL.md` — GTO strategy tools (equity, evaluator, preflop, odds). Included in subagent prompts when a bot has `Use Tools: yes`.

## Project Layout

- `bot_profiles/{name}/personality.md` — Bot identity, model, style, habits (persistent)
- `bot_profiles/{name}/turn.json` — Current game state when it's this bot's turn (ephemeral)
- `bot_profiles/{name}/action.json` — CC writes bot's decision here (ephemeral)
- `pokernow-bot/scripts/orchestrator.js` — Multi-bot WebSocket manager
- `pokernow-bot/scripts/bridge-live.js` — Single-bot WebSocket bridge
- `pokernow-bot/scripts/decide.py` — CLI interface with action validation
- `poker-agent/tools/` — Python calculation tools (equity, odds, hand eval, preflop ranges)

## Critical Rules

### File-Based IPC
The bridge/orchestrator and CC communicate through JSON files, not stdin/stdout. Never try to pipe commands to the Node process.

### Don't Kill Processes Manually
`bridge-live.js` and `orchestrator.js` auto-kill old instances via PID file on startup. Just start a new instance — don't `taskkill` or `kill` manually.

### Information Isolation
Each bot only sees its own hole cards. When spawning subagents for different bots, never leak one bot's cards into another bot's context.

### Action Format
Actions are JSON objects: `{"action": "fold"}`, `{"action": "raise", "amount": 200}`, `{"action": "chat", "message": "gg"}`. Use `decide.py` for validation or validate against the rules in `pokernow-bot/SKILL.md`.

### Turn Timeout
Orchestrator auto check/folds after 60 seconds if no `action.json` is written. Don't spend too long reasoning.

## Common User Requests

| User says | What to do |
|-----------|------------|
| "来一局poker" / "play poker" | Read `pokernow-bot/SKILL.md`, follow multi-bot game flow |
| "建一个新bot" / "create a bot" | Create `bot_profiles/{name}/personality.md` from `.template/` |
| "结束游戏" / "stop game" | Kill orchestrator via PID file, confirm to user |
| "教我打牌" / "coach me" | Read `poker-agent/SKILL.md`, enter coach mode |
