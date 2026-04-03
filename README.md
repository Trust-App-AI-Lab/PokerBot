# PokerBot

AI poker players that play Texas Hold'em on [Poker Now](https://www.pokernow.com) — powered by Claude Code.

Multiple AI bots with distinct personalities, play styles, and skill levels sit at the same table and play live against each other (and you). Just tell Claude Code "来一局poker" and it handles the rest.

## How It Works

You talk to **Claude Code**. Claude Code:

1. Shows you the available bots and lets you pick who plays
2. Writes `game.json` and launches the orchestrator
3. The orchestrator connects all bots to Poker Now via WebSocket
4. When it's a bot's turn, Claude Code reads the game state, loads that bot's personality, and spawns a **subagent** with the matching model to make the decision
5. Each bot thinks independently — no shared information, no cheating

Different Claude models create a natural skill spread:

| Model  | Speed  | Personality Example                     |
|--------|--------|-----------------------------------------|
| haiku  | ~0.5s  | Fish_Bob — loose passive, chases draws  |
| sonnet | ~1.5s  | Shark_Alice — tight aggressive, patient |
| opus   | ~3s    | GTO_Grace — balanced, exploitative      |

## Getting Started

### Prerequisites

- [Claude Code](https://claude.ai/code) (CLI, desktop app, or IDE extension)
- Node.js 18+
- Python 3.10+

### Setup

```bash
cd PokerBot/pokernow-bot
npm install
cp .env.example .env
# Edit .env — set your GAME_URL from pokernow.com
```

### Play

Open Claude Code in the `PokerBot/` directory and say:

> "来一局poker" / "let's play poker" / "开一桌德州"

Claude Code will:
- List available bots from `bot_profiles/`
- Ask which bots you want at the table
- Launch the game and start making decisions for each bot

You can also say things like:
- "加一个新bot，性格是喜欢bluff的老头" — Claude creates a new bot personality
- "让 Shark_Alice 和 Fish_Bob 打一局" — specify exactly who plays
- "结束游戏" / "stop the game" — shut everything down

### Single Bot (Quick Test)

```bash
# Start the bridge for one bot
cd pokernow-bot
node scripts/bridge-live.js --seat

# Then tell Claude Code to make decisions, or use the CLI:
python scripts/decide.py                     # show game state
python scripts/decide.py --act fold          # fold
python scripts/decide.py --act raise 200     # raise to 200
python scripts/decide.py --chat "gg"         # send chat message
```

## Bot Profiles

Each bot lives in `bot_profiles/{name}/personality.md`:

```markdown
## Identity
- **Name**: Fish_Bob
- **Model**: haiku
- **Use Tools**: no

## Character
- **Style**: LP (loose passive)
- **Skill Level**: fish
- **Chat**: Very talkative. "wow nice hand!"

## Habits
- Overvalues any pair and any draw
- Can't fold once he's put chips in
- Chases gut shots without thinking about odds
```

**Model** controls AI capability. **Use Tools** determines whether the bot gets access to equity calculators and GTO strategy docs. A haiku fish with no tools plays badly by nature — no special prompt engineering needed.

Create a new bot by copying the template:

```bash
cp -r bot_profiles/.template bot_profiles/YourBot
# Edit bot_profiles/YourBot/personality.md
```

Or just ask Claude Code: "建一个新bot，TAG风格，用opus模型"

## Project Structure

```
PokerBot/
  bot_profiles/             Each bot's identity + runtime files
    .template/              Copy to create new bots
    Shark_Alice/            Tight-aggressive shark (sonnet)
    Fish_Bob/               Loose-passive fish (haiku)
    Maniac_Charlie/         Wild LAG maniac (sonnet)
    GTO_Grace/              Balanced GTO pro (opus)
    ARIA_Bot/               Default solid player (sonnet)
  poker-agent/              Decision support tools
    tools/                  equity.py, evaluator.py, odds.py, preflop.py
    strategy/               GTO, preflop, postflop, sizing guides
  pokernow-bot/             WebSocket engine
    lib/
      poker-now.js          WebSocket client (Engine.IO v3 / Socket.IO v2)
      game-state.js         Game state parser
    scripts/
      orchestrator.js       Multi-bot game manager
      bridge-live.js        Single-bot WebSocket bridge
      decide.py             CLI interface with action validation
```

## Information Isolation

Fair play is enforced at the architecture level:
- Each bot's `turn.json` only contains that bot's own hole cards
- Subagents are spawned in separate contexts — no access to other bots' data
- The human player's cards (if coached) never enter any bot's context

## License

Private project.
