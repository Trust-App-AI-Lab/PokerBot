# PokerBot

Multi-agent poker system — AI bots with distinct personalities play Texas Hold'em, with Codex as the agent runtime and StuClaw as the app launcher/distribution layer.

## Single Invariant

The app always reads/writes via **localhost:3456** (relay layer), regardless of which backend is running. In-game coaching runs through the **narrator daemon** on `:3460` (event-driven) — no CronCreate polling.

One-command local play (no foreground Codex chat required):
```bash
bash .agents/skills/game/start-game.sh [--name <Name>] [--bots "A,B"] [--auto]     # start everything
bash .agents/skills/game/start-game.sh stop                                        # kill everything
```

## Skills

Four skills, each with its own `SKILL.md`. Invoke them by natural language or the trigger phrases below; the `/name` headings are stable skill identifiers, not a required desktop command syntax.

### `/game` — Game entry point
Full lifecycle of the local self-hosted poker game: welcome flow, bot selection, start/stop, event-driven narrator (manual / auto-play), mode switching, and history review.
**Trigger**: "play poker" / "开一局" / "start game" / "stop game" / "review hands" / "auto play". Remote rooms and text-only play are experimental fallback paths, not the default desktop flow.
**Contains**: `start-game.sh` (full-stack launcher; also handles `stop`/`restart` subcommands), `stop-game.sh`.

### `/coachbot` — Real-time GTO coach
Analysis and user-action proxy layer. Reads game state (or user-described hands), runs GTO tools, outputs coaching prose in Chinese/English. In manual mode it never acts unless explicitly asked; in narrator auto-play it emits a final `ACTION_JSON` line and the relay submits the action.
**Trigger**: strategy questions ("该不该call", "EV多少"), concept explanations ("what's SPR"), hand discussions with no active game. Inside a game, `/game` invokes this per-turn for coaching output.

### `/bot-management` — Bot lifecycle
AI bot personalities (`bots/<name>/personality.md`), Codex thread/session mapping, and the `botmanager.js` event-driven daemon (subscribes to server WS `:3457`). On a global `turn` broadcast it invokes `scripts/codex-agent.js`, parses the bot's JSON decision, and submits the action itself. `botmanager.sh` is legacy file-mode fallback for pokernow experiments.
**Trigger**: "add bot" / "create bot" / "remove bot" / "bot stuck". Also called internally by `/game` at startup.

### `/poker-strategy` — GTO tool library
Python tools: `equity.py`, `preflop.py`, `odds.py`, `evaluator.py` + strategy docs (tiered by skill level).
**Trigger**: internal dependency for coachbot/bots. User-facing strategy questions should route through `/coachbot`.

### Supporting components (not skills, just folders with code + ARCHITECTURE.md)

- **`.agents/skills/poker-server/`** — Self-hosted engine on `:3457` + relay on `:3456` (owns the serialized CoachBot spawn queue) + narrator daemon on `:3460` (event-driven coach trigger + optional auto-play). See `ARCHITECTURE.md` for port layout and API reference when debugging ("server挂了", "3457 down", "narrator 不响").
- **`.agents/skills/pokernow-runtime/`** — Experimental fallback adapter for pokernow.com rooms. File-IPC orchestrator + bridge. See `ARCHITECTURE.md`; this is not part of the default desktop path.

These are infrastructure folders, not user-facing skills. Codex/StuClaw read `ARCHITECTURE.md` on-demand when debugging, not auto-loaded.

### Call hierarchy
`/game` is the entry for normal gameplay and internally uses `/bot-management`, `/coachbot`, `/poker-strategy`, and the poker-server components. `/coachbot` is independently callable for pure analysis with no game running.

## API Quick Reference

All app interaction goes through `localhost:3456` (relay):

| Action | Command |
|---|---|
| Read state | `curl -s localhost:3456/state` |
| Debug-submit current relay user's action | `curl -s -X POST localhost:3456/action -H "Content-Type: application/json" -d '{"action":"call"}'` |
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
- Foreground Codex sessions should not submit per-hand actions during normal play. Use browser buttons or CoachBot panel commands; CoachBot emits `ACTION_JSON` and the relay submits it.

## Permissions

默认情况下，bot 走 `scripts/codex-agent.js`，再调用 StuClaw 提供的 Codex app-server stream adapter；这条路径使用 read-only sandbox，只允许本地只读分析。需要回退时可以设置 `STUCLAW_STREAM_BACKEND=exec`，fallback 也保持 `--sandbox read-only`。Bot/CoachBot 可以跑本地只读工具，但不能写文件、联网，或直接提交牌局动作；动作只由 relay/BotManager 根据最终 JSON 代提交。
