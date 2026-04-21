# PokerBot

Multi-agent poker system — AI bots with distinct personalities play Texas Hold'em, powered by Claude Code. Self-hosted game server (primary) with pokernow.com fallback.

`Self-Hosted` · `WebSocket` · `Multi-Agent` · `GTO Tools` · `Dual-Session` · `Live Coaching`

---

## Quick Start

**Prerequisites**: Claude Code (CLI, desktop, or IDE) · Node.js 18+ · Python 3.10+

```bash
git clone https://github.com/nicekid1/PokerBot.git
cd PokerBot/.claude/skills/poker-server && npm install        # Primary: self-hosted server
cd ../pokernow-runtime && npm install                          # Optional: pokernow.com connector
```

Open Claude Code in `PokerBot/` and say:

> "play poker" — start self-hosted server, open localhost:3457 in browser
>
> "join pokernow.com/games/pglXXXXXX" — join an existing pokernow room (fallback)
>
> "add bots" — add AI players to the table (at start or mid-game)
>
> "create a new bot, aggressive old man who loves to bluff" — build bots with natural language
>
> "public game" — localtunnel for remote access
>
> "stop game" — shut everything down

## Features

**Self-Hosted Server** — Full Texas Hold'em engine on localhost. HTTP + WebSocket on port 3457, browser UI for human players, `/state` and `/action` API for bots. No external dependencies.

**Multi-Agent Bots** — Six AI personalities from fish to pro, each with unique play styles, tells, and decision workflows. Create custom bots with natural language descriptions.

**GTO Strategy Engine** — Five strategy documents (1,025 lines) and five Python calculation tools (1,343 lines). Equity calculator, pot odds, preflop charts, hand evaluator, and range parser. Three-layer architecture: Thinking → Application → Tools.

**Live Coaching** — CoachBot runs in your main session. Real-time GTO advice, hand analysis, and strategy tips while you play. Always responsive, never blocked by bot decisions. Bilingual (English/Chinese).

**Dual-Session Architecture** — Main session for coaching + background BotManager for AI decisions. Each bot spawns as a fresh isolated session with parallel subagents. Zero information leakage.

**PokerNow Fallback** — Join existing pokernow.com rooms with full bot support. WebSocket bridge + file-based IPC orchestrator. Only used when joining someone else's game.

## Architecture

### Two-Port System

| Port | Component | Used By | Role |
|------|-----------|---------|------|
| :3456 | poker-client.js (relay) | CoachBot / CC | Single invariant — CC always reads/writes through this port |
| :3457 | poker-server.js (engine) | BotManager / host | Direct engine access — bots POST actions, host manages config |

CoachBot only hits :3456. BotManager only hits :3457. Never cross.

### Four Subsystems

**poker-server/** — PRIMARY game backend. Self-hosted Texas Hold'em server with HTTP + WebSocket on port 3457, browser UI for human players, `/state` and `/action` API for bots. Optional `--public` flag for LAN play. Each skill owns its own start/stop scripts (`start-server.sh`, `stop-server.sh`).

**pokernow-runtime/** — FALLBACK engine. WebSocket connections to pokernow.com, dual-session architecture, orchestrator for multi-bot management via file-based IPC. Only used when joining someone else's pokernow.com room. Own lifecycle scripts (`start-pokernow.sh`, `stop-pokernow.sh`).

**poker-strategy/** — GTO brain. Five strategy documents teach thinking (not rules) and five Python tools handle calculation. Three-layer architecture: Thinking → Application → Tools.

**bot-management/** — AI personality system. BotManager background loop polls for pending turns every 2s, spawns fresh `claude -p` sessions with parallel subagents. Each bot has identity, habits, and workflow defined in `personality.md`. Own lifecycle scripts (`botmanager.sh`, `stop-botmanager.sh`).

### Information Isolation

Three layers ensure no bot cheats:

**Layer 1 — Data**: Each bot only receives its own hole cards via the API. No cross-bot data at the server level.

**Layer 2 — Prompt**: Bot prompts contain zero file paths, no directory names, no other bot names. Strategy docs are inlined (not read from disk) by skill level.

**Layer 3 — Session**: CoachBot runs in the main session (sees user's cards via relay). Bot decisions run in separate `claude -p` sessions. User's cards never enter any bot's prompt.

## Bot Roster

| Bot | Model | Style | Tools |
|-----|-------|-------|-------|
| GTO Grace | opus | Balanced pro — plays GTO, exploits deviations | Full GTO toolkit |
| Shark Alice | sonnet | Ice-cold shark — TAG, preys on weakness | Equity + odds |
| ARIA Bot | sonnet | Steady regular — solid fundamentals, adaptive | Equity + odds |
| Maniac Charlie | sonnet | Reckless LAG — bluffs heavy, max pressure | Equity only |
| Fish Bob | haiku | Happy fish — calls too much, chases draws | None |

Create new bots with natural language: "create a TAG-style bot using opus model". Each bot lives in `bot-management/bots/{name}/personality.md`. Copy from `.template/` to create manually.

## Dual-Session Architecture

**Main Session = CoachBot**: Always responsive. User chats freely, gets GTO advice, confirms actions. Reads game state via relay API (`:3456/state`), sends actions via `/action`. Never blocked by bot decisions.

**Background = BotManager**: Invisible to user. `botmanager.sh` polls for pending turns every 2s. Each batch spawns a fresh `claude -p` session that creates parallel subagents (one per bot). Submits actions via HTTP POST to `:3457/action`, then exits.

**Game Skill = Orchestrator**: `.claude/skills/game/start-game.sh` delegates to `poker-server/start-server.sh`, joins bots, then starts BotManager. `stop-game.sh` delegates to each skill's stop script in reverse order.

## How a Hand Plays Out

```
Server deals cards
  → Relay pushes state to :3456 (CoachBot sees user's cards)
  → Server sets currentActor

If bot's turn:
  → BotManager detects pending turn
  → Spawns claude -p session with bot personality + strategy
  → Bot calls GET :3457/state?player=BotName
  → Bot runs GTO tools (equity, odds, ranges)
  → Bot POSTs action to :3457/action
  → Session exits

If user's turn:
  → CoachBot reads :3456/state, sees isMyTurn=true
  → Offers GTO advice (optional)
  → User decides, CoachBot POSTs to :3456/action

Repeat until showdown → next hand
```

## Project Structure

```
PokerBot/
  CLAUDE.md                 Project brain: rules, activation triggers, architecture
  AGENTS.md                 Role definitions, SKILL routing, mode routing
  paths.env                 Absolute paths to python/node/claude binaries
  game-data/                Runtime per-player state (gitignored)
  game.json                 Active game config (ephemeral, delete = stop)

  poker-server/             PRIMARY game backend (self-hosted)
    poker-server.js         HTTP + WebSocket server (:3457)
    poker-client.js         Universal relay (:3456)
    start-server.sh         Start server + relay
    stop-server.sh          Stop server + relay
    lib/poker-engine.js     Pure game engine (deal, bet, showdown)
    public/poker-table.html Browser UI (join, play, spectate)

  pokernow-runtime/         FALLBACK engine (pokernow.com)
    scripts/
      orchestrator.js       Multi-bot WebSocket manager + file IPC
      coach-ws.js           CoachBot WebSocket bridge
    start-pokernow.sh       Start bridge + orchestrator
    stop-pokernow.sh        Stop bridge + orchestrator + cleanup
    lib/
      poker-now.js          WebSocket client
      game-state.js         State parser

  poker-strategy/           GTO brain
    strategy/
      gto-fundamentals.md   Thinking framework (300 lines)
      range.md              Range thinking both sides (340 lines)
      preflop.md            Preflop decisions (117 lines)
      postflop.md           Postflop decisions (123 lines)
      sizing.md             Bet sizing theory (145 lines)
    tools/
      equity.py / odds.py / preflop.py / evaluator.py
      range_parser.py       Internal

  bot-management/           AI bot management + personalities
    botmanager.sh           Background bot decision loop
    stop-botmanager.sh      Stop BotManager
    botmanager-init.md      Init prompt: load personality + strategy
    botmanager-turn.md      Turn prompt: read state, decide, act, EXIT
    BOTMANAGER.md           BotManager architecture & isolation rules
    bots/
      .template/            Copy to create new bot
      GTO_Grace/            Balanced pro (opus)
      Shark_Alice/          Ice-cold shark (sonnet)
      ARIA_Bot/             Steady regular (sonnet)
      Maniac_Charlie/       Reckless LAG (sonnet)
      Fish_Bob/             Happy fish (haiku)

  bot_profiles/             Player data (user sessions, CoachBot)
```

## Document Loading Chain

`CLAUDE.md` is always loaded (session auto-load). It routes to different document sets depending on the scenario:

| Scenario | Trigger | Key docs loaded |
|---|---|---|
| Pure Coaching | "how to play AK" / "should I call" | CoachBot SKILL.md + strategy × 5 |
| Start Game (self-hosted) | "play poker" | game SKILL.md + CoachBot docs |
| Start Game (pokernow) | "join pokernow room" | game SKILL.md + pokernow-runtime ARCHITECTURE.md + CoachBot docs |
| Add PlayBots | "add bots" / "let AI play too" | BOTMANAGER.md + bot personality × N |
| BotManager | botmanager.sh auto · every 2s | personality + turn.json + strategy (inlined) |

**Authoritative file list**: `CLAUDE.md` → CoachBot Activation section.

---

PokerBot · 4 subsystems · 6 bots · 5 strategy docs · 5 tools · self-hosted server
