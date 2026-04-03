# PokerBot

Multi-agent poker bot system that plays Texas Hold'em on [Poker Now](https://www.pokernow.com) via WebSocket. Each bot has its own personality, play style, and AI model — powered by Claude.

## Architecture

```
PokerBot/
  bot_profiles/           Bot identities + runtime files
    .template/            Copy to create a new bot
    Shark_Alice/          TAG, patient, ice-cold
    Fish_Bob/             Loose passive, chatty
    Maniac_Charlie/       LAG, wild raises
    GTO_Grace/            Balanced GTO play
    ARIA_Bot/             Default solid player
  poker-agent/            Decision engine
    tools/                Equity calculator, hand evaluator, preflop charts, pot odds
    strategy/             GTO fundamentals, preflop/postflop/sizing guides
  pokernow-bot/           WebSocket engine
    lib/
      poker-now.js        WebSocket client (Engine.IO v3 / Socket.IO v2)
      game-state.js       Game state parser (deep merge with deletion)
    scripts/
      orchestrator.js     Multi-bot game manager
      bridge-live.js      Single-bot bridge (long-running)
      decide.py           CLI interface with action validation
```

## How It Works

1. **WebSocket bridge** connects to Poker Now and maintains game state
2. When it's a bot's turn, the bridge writes `turn.json` with the current game state
3. **Claude** reads the bot's personality + game state, spawns a subagent with the appropriate model
4. Subagent decides an action using poker tools (equity, odds, hand evaluation) or pure heuristics
5. Action is written to `action.json`, bridge reads it and executes via WebSocket

Each bot runs a different Claude model for realistic skill spread:

| Model  | Speed  | Best For                        |
|--------|--------|---------------------------------|
| haiku  | ~0.5s  | Fish, weak players              |
| sonnet | ~1.5s  | Regulars, solid players         |
| opus   | ~3s    | Sharks, GTO-level pros          |

## Quick Start

### Prerequisites

- Node.js 18+
- Python 3.10+
- A [Poker Now](https://www.pokernow.com) game URL

### Single Bot

```bash
# 1. Configure
cd pokernow-bot
cp .env.example .env
# Edit .env with your game URL

# 2. Install dependencies
npm install

# 3. Start the bridge
node scripts/bridge-live.js --seat

# 4. Use decide.py to interact
python scripts/decide.py                     # show game state
python scripts/decide.py --act fold          # fold
python scripts/decide.py --act raise 200     # raise to 200
python scripts/decide.py --chat "gg wp"      # send chat
python scripts/decide.py --host start        # start game (host only)
```

### Multi-Bot Game

```bash
# 1. Write game.json at project root
cat > game.json << 'EOF'
{
  "gameUrl": "https://www.pokernow.com/games/YOUR_GAME_ID",
  "bots": ["Shark_Alice", "Fish_Bob", "Maniac_Charlie"],
  "hostBot": "Shark_Alice",
  "autoSeat": true,
  "stack": 1000
}
EOF

# 2. Launch orchestrator
cd pokernow-bot
node scripts/orchestrator.js
```

The orchestrator connects all bots, manages turns via `pending-turns.json`, and auto check/folds if no decision arrives within 60 seconds.

## Creating a Bot

```bash
# Copy the template
cp -r bot_profiles/.template bot_profiles/YourBot

# Edit personality.md — set model, style, habits
```

Personality fields:

- **Model**: `haiku` / `sonnet` / `opus` — determines AI capability
- **Use Tools**: `yes` / `no` — whether the bot uses equity calculators
- **Style**: `TAG` / `LAG` / `LP` / `TP` — tight-aggressive, loose-aggressive, etc.
- **Habits**: What mistakes this bot makes, how it adjusts, whether it tilts

## Information Isolation

Each bot only sees its own hole cards. Subagents are spawned in separate contexts with no access to other bots' data. Fair play is enforced at the architecture level.

## Poker Tools

The `poker-agent/tools/` module provides:

- **preflop.py** — Opening ranges by position, preflop hand strength
- **equity.py** — Monte Carlo equity simulation against opponent ranges
- **odds.py** — Pot odds, implied odds, expected value calculations
- **evaluator.py** — Hand ranking and evaluation

## Tests

```bash
python pokernow-bot/scripts/test_decide.py          # all tests
python pokernow-bot/scripts/test_decide.py --quick   # skip live tests
```

## License

Private project.
