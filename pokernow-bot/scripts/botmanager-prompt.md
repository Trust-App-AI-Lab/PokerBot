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
   e. **Construct a self-contained prompt** (see template below) — inline ALL data
   f. Spawn a subagent (Agent tool) with the constructed prompt
   g. Extract JSON action from subagent response (regex: `\{"action"\s*:`)
   h. Write action to `PokerBot/bot_profiles/{botName}/action.json`
3. If multiple bots have pending turns, spawn their subagents in PARALLEL (multiple Agent calls in one message)
4. After all actions are written, EXIT immediately — do not loop

## Subagent Prompt Template

**CRITICAL: Information Isolation**
- Inline ALL game state data directly into the prompt text — do NOT include bot_profiles paths
- Do NOT mention `bot_profiles/`, directory structures, or other bots' names
- Do NOT tell the subagent to use Read/Write/Glob/Grep tools for game data
- The subagent should have ZERO knowledge of bot_profiles or other bots' existence
- `Use Tools: yes` bots CAN access `PokerBot/poker-agent/` tools — this is safe (strategy docs are referenced in their Workflow)

**Prompt ordering** (cache-friendly — put stable content first, variable content last):

```
# BLOCK 1: Strategy tools (stable — same across all hands for Use Tools bots)
# Only include if Use Tools == "yes". Largest block, best cache candidate.

{if Use Tools == "yes":}
## Poker Strategy & Calculation Tools
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
You are playing live poker. Follow the Workflow in your identity to decide
your action NOW. Stay in character.

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
