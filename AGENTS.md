---
name: PokerBot
description: >
  Multi-agent poker system — AI bots with distinct personalities play Texas Hold'em with real-time GTO coaching.
  Use when user says "play poker", "开一局", "teach me poker", "review hands", or provides a pokernow.com link.
author: EnyanDai
version: 1.0.0
tags:
  - poker
  - gto
  - multi-agent
  - coaching
  - texas-holdem
metadata:
  openclaw:
    requires:
      bins:
        - node
        - npm
        - python3
        - claude
        - curl
---

# Agents — Role Definitions & Architecture

Three agent roles in the PokerBot system. Each has a clear responsibility boundary.

---

## SKILLs

Five registered skills, invoked via `/skillname`. Each has strict trigger rules — see individual SKILL.md for details.

| SKILL | Invoke | Role | Trigger |
|---|---|---|---|
| **coachbot** | `/coachbot` | Entry point: real-time GTO coach | User explicitly wants to play/learn/analyze poker |
| **bot-management** | `/bot-management` | Bot lifecycle management | User wants to add/create/remove bots, or called internally by coachbot |
| **poker-server** | `/poker-server` | Game engine + relay | Internal infrastructure, never user-facing |
| **pokernow-runtime** | `/pokernow-runtime` | Pokernow.com adapter | Only when message contains a pokernow.com URL |
| **poker-strategy** | `/poker-strategy` | GTO tool library | Pure internal dependency, never triggered directly |

### Call Hierarchy

```
User → /coachbot (sole entry point)
         ├→ /bot-management (when adding/creating bots)
         ├→ /poker-strategy (GTO analysis, internal reference)
         ├→ /poker-server (server debugging, internal reference)
         └→ /pokernow-runtime (only when pokernow URL)
```

**poker-strategy** and **poker-server** should never be triggered directly by user messages.

### Skill-Level Start / Stop

Each skill owns its own start/stop scripts. Root scripts orchestrate across skills.

| Scope | Start | Stop |
|---|---|---|
| **poker-server** (server + relay) | `bash <SKILL_DIR>/start-server.sh --name <Name> [--public]` | `bash <SKILL_DIR>/stop-server.sh` |
| **bot-management** (BotManager) | `bash <SKILL_DIR>/botmanager.sh --server http://localhost:3457 &` | `bash <SKILL_DIR>/stop-botmanager.sh` |
| **pokernow-runtime** (bridge + orchestrator) | `bash <SKILL_DIR>/start-pokernow.sh --url "<url>" --name <Name>` | `bash <SKILL_DIR>/stop-pokernow.sh` |
| **Full game** (all of the above) | `bash start-game.sh --name <Name> [--bots "A,B"] [--public]` | `bash stop-game.sh` |

Root `start-game.sh` delegates to `poker-server/start-server.sh`, then joins bots, then starts BotManager.
Root `stop-game.sh` delegates to each skill's stop script in order: BotManager → pokernow → server.

---

## CoachBot (Main Session)

- **What**: Real-time GTO poker coach running in the main CC session
- **SKILL**: `/coachbot` (all-in-one: trigger rules, identity, GTO flow, coaching style, language)
- **Role**: Observer — reads game state, analyzes with GTO tools, coaches the user. In manual mode, presents options and waits for user decision. In auto-play mode, decides and executes on behalf of the user.
- **Identity**: Every message starts with `🃏 CoachBot:`
- **Language**: Bilingual (Chinese + English). Auto-detects from user's message. Chinese input → Chinese output, always.
- **Proxy**: CoachBot is the user's proxy — the relay joins the server using the **user's name**, not "CoachBot". CoachBot reads the same state the user sees.

### Activation

CoachBot activates when `/coachbot` is invoked (triggered by user's poker-related request). On first activation in a session, follow SKILL.md instructions to load required readings and welcome the user.

### Re-Read Rules

| Rule | Trigger | Action |
|---|---|---|
| **CoachBot re-read** | Uncertain about personality, coaching style, language rules | Re-read `/coachbot` SKILL.md |
| **User correction** | User says "re-read the docs", "use GTO", etc. | IMMEDIATELY re-read `/coachbot` SKILL.md |

### Game Flow (CC responsibility, not CoachBot)

When user issues a game control command (start/stop/switch mode/add bots/config/review), **CC** reads `modes.md` (project root) for the procedure. This is CC's orchestration job — CoachBot does not load or depend on `modes.md`.

### Trigger Keywords (non-exhaustive)
- Chinese: 怎么打, 该不该call, 帮我分析, 教我打牌, 这手牌, EV多少, 胜率多少, 什么range, GTO怎么说
- English: how to play, should I call/raise/fold, coach me, analyze this hand, what's the EV, let's play poker

---

## BotManager (Background Process)

- **What**: Background process that executes AI bot decisions
- **SKILL**: `/bot-management` → loads `BOTMANAGER.md`
- **Role**: Stateless polling loop — polls server every 2s, detects bot turns, invokes `claude -p --resume` for decisions, posts actions back
- **Process**: `botmanager.sh` (started by `start-game.sh`, stopped by `stop-botmanager.sh`)
- **Architecture**: Dual-session — runs separately from main session. Never run bot decisions in the main session (blocks user conversation).

### Session Lifecycle

1. **Init** (done by CC before game starts): `claude -p --session-id <uuid>` loads personality + strategy → "load successfully"
2. **Turn** (done by BotManager during game): `claude -p --resume <uuid>` with turn prompt → curl action
3. **Fresh per game**: `--session-id` always creates new sessions. No resume from previous games.

### Information Isolation

- Each bot only sees its own cards
- Subagent prompts contain NO file paths, NO directory names, NO other bot names
- CoachBot's cards never enter any bot's prompt

---

## PlayBot (AI Opponent)

- **What**: Individual AI poker personality
- **Config**: `/bot-management → bots/<name>/personality.md`
- **Role**: Makes poker decisions based on personality, skill level, and (optionally) GTO tools
- **Skill Levels**: fish (no tools, no strategy docs), regular (3 strategy docs), shark (all 5 docs), pro (all docs + deep GTO)
- **Managed by**: BotManager (init + resume)
- **Create new**: `/bot-management → bots/.template/personality.md` as template → create new bot in `bots/<name>/personality.md`

---

## Mode Routing

Detect from user input:

| User input pattern | Mode | Action |
|---|---|---|
| "play poker" / "开一局" / no URL given | Mode 1 (Host) | `/coachbot` → `bash start-game.sh` |
| IP address or `ws://` URL | Mode 2 (Join remote) | `/coachbot` → `node poker-client.js ws://<addr>:3457` |
| `pokernow.com/games/` URL | Mode 3 (PokerNow) | `/pokernow-runtime` → `start-pokernow.sh` |
| "text mode" / no server needed | Mode 4 (Text) | `/coachbot` → no server, all in chat |

For detailed startup flows, see `modes.md`.

---

## Key Files

| File | Purpose |
|---|---|
| `modes.md` | Game lifecycle: welcome, start/stop game, polling (CronCreate), mode switching, text mode, review |
| `start-game.sh` | Orchestrated start: delegates to skill scripts → join bots → BotManager |
| `stop-game.sh` | Orchestrated stop: delegates to each skill's stop script in order |
| `game-data/` | Runtime shared data: `<name>/state.json`, `<name>/history/`, `<name>/turn.json`, `<name>/action.json` |

---

## API Quick Reference

CC always uses the same API (Modes 1-3), all via localhost:3456:

| Action | Command |
|---|---|
| Read state | `curl -s localhost:3456/state` |
| Send action | `curl -s -X POST localhost:3456/action -H "Content-Type: application/json" -d '{"action":"call"}'` |
| List history sessions | `curl -s localhost:3456/history?sessions` |
| Recent hands | `curl -s localhost:3456/history?last=5` |
| Config (host, :3457) | `GET /config`, `POST /config {"turnTimeout":180000,"smallBlind":25,"bigBlind":50,"stack":1000}` |
| Game control (host, :3457) | `POST /start`, `POST /sit {"player":"name"}`, `GET /info` |

## Action Format

- **Via relay (:3456)**: `{"action": "fold"}`, `{"action": "raise", "amount": 200}` — no player field needed.
- **Direct to server (:3457, BotManager)**: `{"player": "Shark_Alice", "action": "call"}` — player field required.

## Game End

`bash stop-game.sh` handles ALL modes. Delegates to each skill's stop script, full cleanup.

## Common User Requests

| User says | What to do |
|---|---|
| "play poker" / "开一局" | `/coachbot` → Mode 1 startup flow |
| "text mode" | `/coachbot` → Mode 4 (text mode) |
| "teach me" / "教学" | `/coachbot` → Mode 1 + coaching bots |
| "join <IP>" | `/coachbot` → Mode 2 |
| "join <pokernow link>" | `/pokernow-runtime` → Mode 3 |
| "stop game" | See `modes.md` → CronDelete + `bash stop-game.sh` |
| "add bots" | `/bot-management` |
| "create bot" | `/bot-management` |
| Any poker advice keyword | `/coachbot` (if not already loaded) |
| "review hands" | `/coachbot` → review mode |

## History Format

Unified JSONL: `hand_start → action → board → hand_end`, each line with `ts` timestamp.
- Server history: `/poker-server → history.jsonl` (cards redacted at hand_start, shown at hand_end)
- Per-player history: `game-data/<name>/history/<ts>.jsonl` (information-isolated, rotates at 100 hands)
