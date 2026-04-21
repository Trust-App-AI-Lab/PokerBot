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

Manages the lifecycle of AI poker bots: personality definition, session initialization, turn-by-turn decision execution, and process management.

## Activation

When this SKILL is invoked, load:

1. Load `BOTMANAGER.md` (this directory) — architecture, session flow, polling loop
2. Scan `bots/*/personality.md` (this directory) to discover available bots

## What This SKILL Contains

- `BOTMANAGER.md` — BotManager architecture, session init + resume flow, polling loop
- `botmanager.sh` — executable polling loop (background process)
- `botmanager-init.md` — prompt template for bot initialization
- `botmanager-turn.md` — prompt template for bot turn execution
- `bots/` — play bot personalities:
  - `bots/.template/personality.md` — template for creating new bots
  - `bots/Shark_Alice/personality.md` — tight-aggressive, shark level
  - `bots/Fish_Bob/personality.md` — loose-passive, fish level
  - `bots/Maniac_Charlie/personality.md` — hyper-aggressive, regular level
  - `bots/GTO_Grace/personality.md` — balanced TAG, pro level
  - `bots/ARIA_Bot/personality.md`, `bots/ARIA_Bot_2/personality.md`

## Key Concepts

- **Dual-session architecture** — Main session = CoachBot (user interaction). BotManager = background process (bot decisions). Never run bot decisions in the main session.
- **Fresh sessions per game** — `--session-id` always creates new sessions. No resume from previous games.
- **Skill-level gating** — fish bots read no strategy docs; regular bots read 3; shark/pro bots read all 5.
- **Information isolation** — each bot only sees its own cards. No file paths or other bot names in subagent prompts.

## Start / Stop

### Start BotManager

```bash
bash <SKILL_DIR>/botmanager.sh --server http://localhost:3457 &
```

Auto-detects mode (HTTP if server available, file IPC otherwise). Kills old BotManager if running, writes PID to `.botmanager.pid`.

### Stop BotManager

```bash
bash <SKILL_DIR>/stop-botmanager.sh
```

Kills BotManager via PID file, cleans up.

> **Note**: For full game startup/shutdown (server + relay + bots + BotManager), use `start-game.sh` / `stop-game.sh` in project root.

## Dependencies

- `/poker-strategy` — bots load strategy docs + call GTO tools (based on skill level tier)
- **game-data/** — BotManager reads state, bots write action decisions
- `.claude/skills/poker-server/` — BotManager communicates via HTTP API (`localhost:3457`). Not a skill; see `ARCHITECTURE.md`.
