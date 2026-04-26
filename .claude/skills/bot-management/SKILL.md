---
name: bot-management
description: >
  PokerBot internal SKILL — AI poker bot lifecycle management. Only trigger when: user explicitly asks to add/remove bots ("加几个bot", "add bots", "remove bot"), create a custom bot ("建一个新bot", "create bot"), or debug bot behavior ("bot怎么不动了", "bot stuck"). Usually called internally by /coachbot during game startup, not as a standalone entry point. Do NOT trigger on general AI/robot/automation discussion.
author: EnyanDai
version: 1.0.0
tags:
  - poker
  - bot
  - management
  - internal
metadata:
  openclaw:
    requires:
      bins:
        - node
        - python3
        - claude
        - curl
---

# Bot Management — AI Bot Lifecycle

Manages the lifecycle of AI poker bots: personality definition, turn-by-turn decision execution, and process management.

## Activation

Scan `bots/*/personality.md` (this directory) to discover available bots.

## What This SKILL Contains

- `botmanager.js` — event-driven WS subscriber (HTTP mode, default)
- `botmanager.sh` — legacy polling loop (file mode only, pokernow fallback)
- `botmanager-turn.md` — turn prompt template (the only prompt — no separate init)
- `bots/` — play bot personalities:
  - `bots/.template/personality.md` — template for creating new bots
  - `bots/Shark_Alice/personality.md` — tight-aggressive, shark level
  - `bots/Fish_Bob/personality.md` — loose-passive, fish level
  - `bots/Maniac_Charlie/personality.md` — hyper-aggressive, regular level
  - `bots/GTO_Grace/personality.md` — balanced TAG, pro level
  - `bots/ARIA_Bot/personality.md`, `bots/ARIA_Bot_2/personality.md`

## Architecture

**Dual-session**: main CC session = CoachBot (user interaction). BotManager = background daemon that wakes on server events, invokes `claude -p` when a known bot is `currentActor`. Never run bot decisions in the main session.

**Event-driven (HTTP mode, default)**: `botmanager.js` opens one WebSocket to `ws://localhost:3457` as an unjoined observer. The server broadcasts a global `'turn'` event (player name, handNumber, phase — no hole cards) inside the `action_required` handler. On each `turn` event, BotManager:
1. Checks `player` against `bots/<name>/personality.md` (and excludes `CoachBot`, and honors `--bots A,B` allow-list if given).
2. `GET /state?player=<name>` — fetches the bot's info-isolated view with hole cards.
3. Spawns `claude -p` with the turn prompt; the bot curls `POST /action` once, then exits.

No polling, no 2-second wake-up tax. Symmetric with the narrator daemon (which does the equivalent for CoachBot on the relay side).

**Push, not pull**: state arrives in the prompt, not fetched by the bot. Bot wakes with hole cards, board, pot, stacks, `legalActions` already in front of it and only curls once to POST `/action`.

**File mode (pokernow fallback)**: `botmanager.sh` still exists for the file-IPC path (pokernow runtime writes `pending-turns.json`, no server WS to subscribe to). Not used in HTTP mode.

**Turn prompt**: pure concat, re-assembled fresh on every invocation — no init step.

```
<botmanager-turn.md>       ← shared 4-step instructions + rules
---
<personality body>         ← character + character's Your Tools / Your Docs tables
---
SERVER_URL=..., BOT_NAME=...

## State
<JSON from /state?player=$bot>
```

- First turn: `claude -p "<prompt>" --session-id <sid> --model <m> --permission-mode bypassPermissions`
- Subsequent turns: same, but `--resume <sid>` — in-game observations (past hands, opponent reads) carry forward via the session; turn.md + personality are re-fed every turn to defeat compaction drift. The static prefix is byte-identical turn-to-turn → Anthropic prompt cache hits.

**Session ID**: `md5("pokerbot-$BOT_NAME")` formatted as UUID (epoch 0, byte-compatible with the shell version). After each periodic clear the SID becomes `md5("pokerbot-$BOT_NAME-v$epoch")`.

**Periodic session clear** (HTTP mode only): every 10 hands per bot, at the hand boundary BEFORE the bot's first action of the new hand, BotManager
1. runs a maintenance turn on the OLD session asking the bot to emit a short bullet summary of opponent observations (captured from stdout),
2. stashes the summary in `BOT_MEMORY[bot]` (in-memory),
3. increments `BOT_EPOCHS[bot]` — next turn spawns on a brand-new UUID with `--session-id`,
4. `buildTurnPrompt` injects the stashed summary as a `## Carryover from previous hands` block into the fresh session's prompt.

This caps transcript growth + keeps the static prefix cache-warm within each epoch, without losing hard-won opponent reads at the boundary.

**Personality structure** (per `bots/<Name>/personality.md`):
- Frontmatter: only `model` (`haiku` / `sonnet` / `opus`).
- Body: character blurb + `## Your Tools` + `## Your Docs` tables tailored to this bot. Fish/Maniacs use "None — <reason>" in place of the tables. The bot sees ONLY what its personality lists — no generic menu, no allow-list filtering in the script.

**Information isolation**: server `/state?player=X` only returns X's hole cards. Bots can Read ONLY `.claude/skills/poker-strategy/strategy/*.md` — no Glob, no Grep, no other paths. Enforced by `botmanager-turn.md` rules.

## Start / Stop

### Start BotManager

HTTP mode (default — event-driven):
```bash
node <SKILL_DIR>/botmanager.js --server http://localhost:3457 &
```

File mode (pokernow fallback — polling loop):
```bash
bash <SKILL_DIR>/botmanager.sh &
```

Both write PID to `.botmanager.pid` and kill any old BotManager first.

### Stop BotManager

```bash
bash <SKILL_DIR>/stop-botmanager.sh
```

Kills BotManager via PID file, cleans up.

> **Note**: For full game startup/shutdown (server + relay + bots + BotManager), use `start-game.sh` / `stop-game.sh` in project root.

## Dependencies

- `/poker-strategy` — tool/doc definitions. Each personality inlines its own subset (command, returns, when to reach for it). Strategy docs are Read on-demand by bots per spot.
- `.claude/skills/poker-server/` — BotManager communicates via HTTP API (`localhost:3457`). Not a skill; see `ARCHITECTURE.md`.
