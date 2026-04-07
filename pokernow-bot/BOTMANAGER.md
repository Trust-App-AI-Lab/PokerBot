# BotManager — Autonomous Bot Decision Engine

BotManager runs as a **background process** alongside the main CC session.
It polls for pending bot turns and invokes `claude -p` to handle each batch.

## Architecture

```
botmanager.sh (Bash outer loop, runs in background)
  │
  ├─ every 2s: check pending-turns.json
  │
  └─ if turns pending:
       claude -p "botmanager-prompt.md"  (short-lived CC session)
         │
         ├─ Agent(haiku)  → Fish_Bob decision     ─┐
         ├─ Agent(sonnet) → Shark_Alice decision   ─┼─ parallel
         └─ Agent(opus)   → GTO_Grace decision     ─┘
         │
         └─ write action.json per bot → exit
```

**Why this design:**
- Bash loop handles polling (simple, no context accumulation)
- Each `claude -p` is a fresh session (reads current state, decides, writes, exits)
- No long-running CC session that fills up context over many hands
- Multiple Agent calls in one message = parallel bot decisions

## Launching BotManager

CC launches BotManager after writing game.json and starting orchestrator:

```bash
cd PokerBot/pokernow-bot && bash scripts/botmanager.sh &
```

BotManager runs until game.json is deleted (= game ended).

## botmanager.sh

The outer loop script. Lives at `pokernow-bot/scripts/botmanager.sh`:

```bash
#!/bin/bash
# botmanager.sh — BotManager outer loop
# Polls pending-turns.json, invokes claude -p for each batch of turns.
# Exits when game.json is deleted.

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PENDING="$PROJECT_ROOT/pending-turns.json"
GAME="$PROJECT_ROOT/game.json"
PROMPT="$PROJECT_ROOT/pokernow-bot/scripts/botmanager-prompt.md"

echo "[BotManager] Started (PID $$). Watching for pending turns..."
echo $$ > "$PROJECT_ROOT/botmanager.pid"

while [ -f "$GAME" ]; do
  # Check if there are pending turns
  if [ -f "$PENDING" ]; then
    count=$(python3 -c "import json; print(json.load(open('$PENDING')).get('count',0))" 2>/dev/null || echo "0")
    if [ "$count" -gt "0" ]; then
      echo "[BotManager] $count pending turn(s) — invoking claude -p"
      claude -p "$(cat "$PROMPT")" --allowedTools "Read,Write,Edit,Glob,Grep,Agent,Bash(python *),Bash(python3 *)" 2>/dev/null
    fi
  fi
  sleep 2
done

echo "[BotManager] game.json deleted — exiting."
rm -f "$PROJECT_ROOT/botmanager.pid"
```

## botmanager-prompt.md

The prompt given to each `claude -p` invocation. Lives at `pokernow-bot/scripts/botmanager-prompt.md`.
Each invocation is **stateless** — it reads current pending turns, makes decisions, writes actions, and exits.

````markdown
# BotManager — Handle Pending Bot Turns

You are handling one batch of pending poker bot turns. Read the current state,
make decisions for each bot, write action files, then EXIT.

## Your Task

1. Read `PokerBot/pending-turns.json`
2. For each bot in the turns list:
   a. Read `PokerBot/bot_profiles/{botName}/personality.md` — bot identity + workflow
   b. Read `PokerBot/bot_profiles/{botName}/turn.json` — current game state
   c. Extract the `Model` field from personality.md → use as subagent model
   d. Extract the `Use Tools` field — if "yes", also read `PokerBot/poker-agent/SKILL.md`
   e. Extract the `Skill Level` field — read the strategy docs this bot needs (see table below):
      | Skill Level | Strategy docs to read + inline |
      |---|---|
      | fish | (none) |
      | regular | `preflop.md`, `postflop.md`, `range.md` |
      | shark / pro | ALL 5: `gto-fundamentals.md`, `preflop.md`, `postflop.md`, `sizing.md`, `range.md` |
      All paths are under `PokerBot/poker-agent/strategy/`.
   f. **Construct a self-contained prompt** (see template below) — inline ALL data
   g. Spawn a subagent (Agent tool) with the constructed prompt
   h. Extract JSON action from subagent response (regex: `\{"action"\s*:`)
   i. Write action to `PokerBot/bot_profiles/{botName}/action.json`
3. If multiple bots have pending turns, spawn their subagents in PARALLEL (multiple Agent calls in one message)
4. After all actions are written, EXIT immediately — do not loop

## Subagent Prompt Template

**CRITICAL: Information Isolation**
- Inline ALL game state data directly into the prompt text — do NOT include bot_profiles paths
- Do NOT mention `bot_profiles/`, directory structures, or other bots' names
- Do NOT tell the subagent to use Read/Write/Glob/Grep tools for game data
- The subagent should have ZERO knowledge of bot_profiles or other bots' existence
- When inlining personality.md, strip file path references (e.g. `poker-agent/strategy/preflop.md` → just `preflop strategy`) — the content is already inlined in Block 1
- `Use Tools: yes` bots get strategy docs + SKILL.md inlined in Block 1. Subagents CAN call `poker-agent/tools/*.py` but should NOT Read any files

**Prompt ordering** (cache-friendly — put stable content first, variable content last):

```
# BLOCK 1: Strategy knowledge + tools (stable — same across all hands for this bot)
# Only include if Use Tools == "yes". Largest block, best cache candidate.
# Which strategy docs to include depends on Skill Level (see step 2e).

{if Use Tools == "yes":}
## Poker Strategy Knowledge
{contents of strategy docs per Skill Level:}
{  regular: preflop.md + postflop.md + range.md}
{  shark/pro: gto-fundamentals.md + preflop.md + postflop.md + sizing.md + range.md}

## Poker Calculation Tools
{contents of poker-agent/SKILL.md}

# BLOCK 2: Bot identity + workflow (stable — same for this bot across all hands)
# personality.md now contains both identity AND decision workflow.

## Your Identity & Decision Process
{contents of personality.md}

# BLOCK 3: Memory (semi-stable — grows slowly, changes between hands)
# Reserved for future memory system. Currently empty.

## Session Memory
(No prior history yet.)

# BLOCK 4: Current hand (changes every turn — always last)

## Current Game State
{contents of turn.json, formatted as readable text}

## Your Task
You are playing live poker. Decide your action NOW based on your identity,
strategy knowledge, and the current game state.

Return ONLY a JSON object, nothing else:
- Fold: {"action": "fold"}
- Check: {"action": "check"}
- Call: {"action": "call"}
- Raise: {"action": "raise", "amount": <number>}

You may optionally include a chat message in character:
{"action": "raise", "amount": 200, "chat": "nice hand"}
```

## JSON Extraction

Subagents may return mixed text + JSON. Extract the action using:
1. Look for `{"action"` in the response
2. Extract the JSON object (handle nested braces)
3. Fallback: if no valid JSON found, use `{"action": "check"}`

## Critical Rules

- Do NOT loop — handle current batch and EXIT
- NEVER give subagents any file paths or directory names (information isolation)
- NEVER read CoachBot's files — CoachBot is the user's coach, not your concern
- NEVER modify game.json — only the main session controls game config
- If pending-turns.json has count=0 or doesn't exist → exit immediately (nothing to do)
````

## Model Assignment

Each bot's `personality.md` has a `Model` field:

| Model | Cost | Speed | Best for |
|-------|------|-------|----------|
| haiku | $ | ~5s | Fish, weak players. Natural mistakes. |
| sonnet | $$ | ~15s | Regulars, solid players. Good balance. |
| opus | $$$ | ~30s | Sharks, GTO pros. Strongest reasoning. |

Weaker models naturally make worse decisions = realistic skill spread at the table.

## Information Isolation

Critical for fair play. Three layers:

**Layer 1 — Data isolation (orchestrator)**
- Each bot's turn.json ONLY contains that bot's own hole cards
- history.jsonl per bot only records what that bot could legitimately observe

**Layer 2 — Prompt isolation (BotManager)**
- BotManager reads bot data and inlines it into subagent prompts as plain text
- Subagent prompts contain NO file paths, NO directory names, NO other bot names
- Subagents have zero knowledge of the project filesystem or other bots' existence

**Layer 3 — Session isolation (dual-session)**
- CoachBot runs in the main session; bot decisions run in background `claude -p` sessions
- CoachBot sees user's cards via browser bridge but this info never enters any bot's prompt
- Each `claude -p` invocation spawns separate subagent per bot (context isolation)

## Stopping

BotManager exits automatically when game.json is deleted:
- `botmanager.sh` checks `[ -f game.json ]` every 2s in its while loop
- When game.json disappears → loop exits → script ends
- CC can also `kill $(cat PokerBot/botmanager.pid)` if needed

## Creating a New Bot

```bash
# 1. Create profile directory
mkdir PokerBot/bot_profiles/NewBotName/

# 2. Copy and edit personality
cp PokerBot/bot_profiles/.template/personality.md PokerBot/bot_profiles/NewBotName/

# 3. Or let CC generate personality from user description:
#    User: "建一个喜欢慢打的老头bot"
#    CC: writes personality.md with TP style, haiku model, passive strategy
```
