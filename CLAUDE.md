# PokerBot

Multi-agent poker system — AI bots with distinct personalities play Texas Hold'em, with Claude Code as the orchestration layer.

## Single Invariant

CC always reads/writes via **localhost:3456** (relay layer), regardless of which backend is running. In-game coaching runs through the **narrator daemon** on `:3460` (event-driven) — no CronCreate polling.

One-command local play (no CC required):
```bash
bash .claude/skills/game/start-game.sh [--name <Name>] [--bots "A,B"] [--auto]     # start everything
bash .claude/skills/game/start-game.sh stop                                        # kill everything
```

## Skills

Four skills, each with its own SKILL.md. Trigger via `/<name>` — full rules are in each skill's frontmatter.

### `/game` — Game entry point
Full lifecycle of a poker game: welcome flow, bot selection, start/stop, event-driven narrator (manual / auto-play), mode switching, text mode, history replay.
**Trigger**: "play poker" / "开一局" / "start game" / "stop game" / "join <IP>" / "review hands" / pokernow URL / "text mode".
**Contains**: `start-game.sh` (full-stack launcher; also handles `stop`/`restart` subcommands), `stop-game.sh`.

### `/coachbot` — Real-time GTO coach
Pure analysis layer. Reads game state (or user-described hands), runs GTO tools, outputs coaching prose in Chinese/English. Observer role — does not act autonomously unless user asks.
**Trigger**: strategy questions ("该不该call", "EV多少"), concept explanations ("what's SPR"), hand discussions with no active game. Inside a game, `/game` invokes this per-turn for coaching output.

### `/bot-management` — Bot lifecycle
AI bot personalities (`bots/<name>/personality.md`), claude session init (`--session-id`), and the `botmanager.js` event-driven daemon (subscribes to server WS `:3457`) that executes bot turns via `claude -p --resume` when a global `turn` broadcast arrives. `botmanager.sh` stays as the file-mode fallback for pokernow.
**Trigger**: "add bot" / "create bot" / "remove bot" / "bot stuck". Also called internally by `/game` at startup.

### `/poker-strategy` — GTO tool library
Python tools: `equity.py`, `preflop.py`, `odds.py`, `evaluator.py` + strategy docs (tiered by skill level).
**Trigger**: direct tool calls ("equity AKs vs QQ"), or internal dependency for coachbot/bots.

### Supporting components (not skills, just folders with code + ARCHITECTURE.md)

- **`.claude/skills/poker-server/`** — Self-hosted engine on `:3457` + relay on `:3456` (owns the serialized CoachBot spawn queue) + narrator daemon on `:3460` (event-driven coach trigger + optional auto-play). See `ARCHITECTURE.md` for port layout and API reference when debugging ("server挂了", "3457 down", "narrator 不响").
- **`.claude/skills/pokernow-runtime/`** — Fallback adapter for playing on pokernow.com. File-IPC orchestrator + bridge. See `ARCHITECTURE.md`. Used when the user provides a `pokernow.com/games/` URL.

These aren't slash-command skills — they're infrastructure folders. CC reads `ARCHITECTURE.md` on-demand when debugging, not auto-loaded.

### Call hierarchy
`/game` is the entry for any gameplay and internally calls `/bot-management`, `/poker-strategy`, `/coachbot`, and the poker-server / pokernow-runtime components. `/coachbot` and `/poker-strategy` are independently callable for pure analysis or direct tool use with no game running.

## API Quick Reference

All CC interaction via `localhost:3456` (relay):

| Action | Command |
|---|---|
| Read state | `curl -s localhost:3456/state` |
| Send action | `curl -s -X POST localhost:3456/action -H "Content-Type: application/json" -d '{"action":"call"}'` |
| History sessions | `curl -s localhost:3456/history?sessions` |
| Recent hands | `curl -s localhost:3456/history?last=5` |

Server control (host only, via `:3457`): `POST /config`, `POST /start`, `POST /sit`, `GET /info`, `POST /join`.

Coach + narrator (via `:3456` / `:3460`):

| Action | Command |
|---|---|
| Ask CoachBot | `curl -s -X POST localhost:3456/coach-ask -H "Content-Type: application/json" -d '{"question":"..."}'` |
| Narrator mode → auto | `curl -s -X POST localhost:3460/mode -H "Content-Type: application/json" -d '{"mode":"auto"}'` |
| Narrator mode → manual | `curl -s -X POST localhost:3460/mode -H "Content-Type: application/json" -d '{"mode":"manual"}'` |
| Narrator status | `curl -s localhost:3460/mode` |

## Action Format

- **Via relay (:3456)**: `{"action": "fold"}`, `{"action": "raise", "amount": 200}` — no player field.
- **Direct to server (:3457, BotManager)**: `{"player": "Shark_Alice", "action": "call"}` — player field required.

## Permissions

当前阶段 **CC 和 bot 全部走 `bypassPermissions`**（见 `.claude/settings.local.json`、BotManager 的 `claude -p --permission-mode bypassPermissions`）。后续再做细化权限管理（allow 列表 / 路径限制）。
