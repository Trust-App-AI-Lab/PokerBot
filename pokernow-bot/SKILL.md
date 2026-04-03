---
name: pokernow-bot
description: >
  Play Texas Hold'em on Poker Now (pokernow.com) — multi-agent poker system.
  Supports single bot or N-bot games with different AI personalities and models.
  Trigger when user mentions Poker Now, poker bot, 德州扑克, "play poker",
  "来一局", "开一桌", or the PokerBot project.
---

# Poker Now Bot — Multi-Agent Architecture

Claude plays Texas Hold'em LIVE on Poker Now via WebSocket.
Supports single-bot play and multi-bot games with different personalities and models.

## Project Structure

```
PokerBot/
  pokernow-bot/           ← Engine (WebSocket, protocol, game state)
    lib/
      poker-now.js        ← WebSocket client (multi-session capable)
      game-state.js       ← Game state parser
    scripts/
      orchestrator.js     ← Multi-bot manager (reads game.json)
      bridge-live.js      ← Single-bot bridge (long-running)
      decide.py           ← Python CLI interface
  bot_profiles/           ← Each bot's identity + runtime files
    .template/            ← Copy to create new bot
    Shark_Alice/
      personality.md      ← Identity, style, model, strategy
      .cookies            ← Session (auto-generated, git-ignored)
      turn.json           ← Written when it's this bot's turn (ephemeral)
      action.json         ← CC writes decision here (ephemeral)
      state.json          ← Current game snapshot (ephemeral)
      history.jsonl       ← Game history (persistent, for review)
      bridge.pid          ← Process ID (ephemeral)
    Fish_Bob/
    ...
  game.json               ← Current game config (ephemeral)
```

## Multi-Bot Game Flow

### Step 1: User says "来一局poker"

CC scans `PokerBot/bot_profiles/` and lists available bots:

```
Available bots:
  Shark_Alice     TAG (sonnet)  — 紧凶，沉默寡言
  Fish_Bob        LP  (haiku)   — 松被动鱼，话多
  Maniac_Charlie  LAG (sonnet)  — 疯狂raise，挑衅
  GTO_Grace       TAG (opus)    — GTO平衡，最强
  ARIA_Bot        TAG (sonnet)  — 默认稳健
```

Ask user: which bots? how many players? create new ones?

### Step 2: User selects bots (and optionally creates new ones)

If user wants a new bot:
1. `mkdir PokerBot/bot_profiles/NewBotName/`
2. Write `personality.md` based on user's description
3. Set model field (haiku/sonnet/opus) based on desired skill level

### Step 3: CC writes game.json and launches orchestrator

```json
{
  "gameUrl": "https://www.pokernow.com/games/xxx",
  "bots": ["Shark_Alice", "Fish_Bob", "Maniac_Charlie"],
  "hostBot": "Shark_Alice",
  "autoSeat": true,
  "stack": 1000
}
```

```bash
cd PokerBot/pokernow-bot && node scripts/orchestrator.js &
```

Orchestrator connects all bots sequentially (3s apart to avoid rate limits),
requests seats, and begins watching for turns.

### Step 4: Decision Loop

CC watches ONE file: `PokerBot/pending-turns.json`

```json
{
  "count": 1,
  "turns": [
    { "botName": "Fish_Bob", "since": "...", "timeout_at": "...", "seconds_left": 25 }
  ],
  "updated": "2026-04-03T12:00:00.000Z"
}
```

When a turn appears:

1. CC reads `pending-turns.json` → sees which bot needs a decision
2. CC reads `bot_profiles/{botName}/personality.md` → extracts **Model** and **Use Tools**
3. CC reads `bot_profiles/{botName}/turn.json` → game state
4. CC assembles subagent prompt:

   **If Use Tools = yes:**
   ```
   prompt = personality.md
          + turn.json game state
          + poker-agent/SKILL.md (FULL content — tool docs + decision workflow)
   ```

   **If Use Tools = no:**
   ```
   prompt = personality.md
          + turn.json game state
          (no tool instructions — bot plays by personality heuristics only)
   ```

5. CC spawns subagent:
   ```
   Agent(
     model = personality.model,   // haiku / sonnet / opus
     prompt = assembled above
   )
   ```
6. Subagent decides (with or without tools) → returns `{"action": "...", "amount": ...}`
7. CC writes `bot_profiles/{botName}/action.json`
8. Orchestrator reads action.json → executes → clears pending turn

If CC doesn't respond within 60s → orchestrator auto check/fold (safe fallback).

### Why include poker-agent/SKILL.md in the prompt?

Subagents do NOT automatically have access to Skills. They only know what CC
puts in their prompt. By including poker-agent/SKILL.md, the subagent gets:
- Full tool CLI docs (preflop.py, equity.py, odds.py, evaluator.py)
- Decision workflow (assess → preflop check → equity calc → sizing → decide)
- Strategy doc paths it can `Read` for deeper reasoning

### CC pseudo-code for the decision loop

```python
# When pending-turns.json shows a bot needs a decision:
for turn in pending_turns:
    bot_name = turn["botName"]
    personality = Read(f"bot_profiles/{bot_name}/personality.md")
    game_state  = Read(f"bot_profiles/{bot_name}/turn.json")

    # Extract fields from personality
    model     = extract(personality, "Model")      # haiku / sonnet / opus
    use_tools = extract(personality, "Use Tools")  # yes / no

    # Build prompt
    prompt = f"{personality}\n\n## Current Game State\n{game_state}"
    if use_tools == "yes":
        poker_skill = Read("poker-agent/SKILL.md")
        prompt += f"\n\n## Poker Agent Tools & Strategy\n{poker_skill}"

    prompt += "\n\nDecide now. Return ONLY a JSON object, no other text: {\"action\": \"fold/check/call/raise\", \"amount\": number_or_null}"

    # Spawn subagent with the right model
    result = Agent(model=model, prompt=prompt)

    # Extract JSON from agent response (agents may return text + JSON mixed)
    import json, re
    match = re.search(r'\{[^{}]*"action"\s*:', result)
    if match:
        # Find the complete JSON object starting from the match
        json_str = result[match.start():]
        # Take up to the first closing brace after the match
        brace_end = json_str.index('}') + 1
        action = json.loads(json_str[:brace_end])
    else:
        # Fallback: agent didn't return valid JSON → auto check/fold
        action = {"action": "check", "amount": None}

    Write(f"bot_profiles/{bot_name}/action.json", json.dumps(action))
```

### Step 5: Health Monitoring

CC can check `PokerBot/orchestrator-heartbeat.json`:
```json
{
  "alive": true,
  "pid": 12345,
  "uptime_s": 300,
  "bots": {
    "Shark_Alice": { "connected": true, "actionInProgress": false, "hasPendingTurn": false, "reconnects": 0 },
    "Fish_Bob":    { "connected": true, "actionInProgress": false, "hasPendingTurn": false, "reconnects": 0 }
  },
  "pending_turns": 0,
  "timestamp": "2026-04-03T12:00:00.000Z"
}
```
If heartbeat file is >15s stale → orchestrator is dead, CC should restart it.

### Step 6: Coach Mode (optional)

CC itself acts as coach for the human player:
- Reads user's cards via Chrome DevTools
- Provides strategic advice in the chat
- Does NOT pass user's cards to any bot subagent (information isolation)

## Model Assignment

Each bot's `personality.md` has a `Model` field:

| Model | Cost | Speed | Best for |
|-------|------|-------|----------|
| haiku | $ | ~0.5s | Fish, weak players. Natural mistakes. |
| sonnet | $$ | ~1.5s | Regulars, solid players. Good balance. |
| opus | $$$ | ~3s | Sharks, GTO pros. Strongest reasoning. |

Weaker models naturally make worse decisions = realistic skill spread at the table.

## Information Isolation

Critical for fair play:
- Each bot's turn.json ONLY contains that bot's own hole cards
- Bot subagents have NO access to other bots' cards
- CC spawns separate subagent per bot (context isolation)
- Coach sees user's cards but this info never enters any bot's turn data
- history.jsonl per bot only records what that bot could legitimately observe

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

## Single-Bot Mode (Legacy)

Still works for quick testing with one bot:

### Configure .env
```
GAME_URL=https://www.pokernow.com/games/GAME_ID
BOT_NAME=ARIA_Bot
SEAT=5
STACK=1000
```

### Start bridge
```bash
cd pokernow-bot && node scripts/bridge-live.js --seat
```

### CLI Commands (decide.py)

All files read/written in `PokerBot/bot_profiles/{BOT_NAME}/` (matches bridge-live.js paths).

```bash
python pokernow-bot/scripts/decide.py                    # show state
python pokernow-bot/scripts/decide.py --act fold/check/call/raise
python pokernow-bot/scripts/decide.py --act raise 200
python pokernow-bot/scripts/decide.py --chat "gg wp"
python pokernow-bot/scripts/decide.py --host start/stop/pause/resume/next
python pokernow-bot/scripts/decide.py --approve <playerID> [stack]
python pokernow-bot/scripts/decide.py --kick <playerID>
```

## Stopping a Game

When user says "结束游戏" / "stop the game" / "关桌", CC should:

### Multi-Bot Mode (orchestrator)
```bash
# Read PID and send SIGTERM — orchestrator cleans up everything automatically
kill $(cat PokerBot/orchestrator.pid) 2>/dev/null
```
Orchestrator's SIGTERM handler will:
- Disconnect all bots' WebSockets
- Delete all ephemeral files (pending-turns.json, heartbeat, per-bot turn/action/state.json, PIDs)
- Keep history.jsonl (persistent, for review)

### Single-Bot Mode (bridge-live.js)
```bash
kill $(cat PokerBot/bot_profiles/{botName}/bridge.pid) 2>/dev/null
```
Same pattern: SIGTERM → graceful cleanup → process exits.

### After Killing
CC should confirm to user: "游戏已结束，所有bot已断开。" No further pending-turns polling needed.

## Robustness

### Turn Timeout (60s)
If CC doesn't write action.json within 60 seconds, orchestrator auto check/fold.
This prevents Poker Now from timing out the bot and skipping its turn entirely.
60s allows enough time for opus bots to run equity calculations + deep reasoning.
Haiku bots typically respond in 5-10s, sonnet in 10-20s, opus in 20-40s.

### Per-Bot Reconnection
If one bot's WebSocket drops, ONLY that bot reconnects. Other bots are unaffected.
Exponential backoff: 5s → 7.5s → 11s → ... → max 60s. Up to 20 attempts.
On successful reconnect, counter resets to 0.

### Orchestrator Crash Recovery
If orchestrator dies:
1. CC detects stale heartbeat (>15s old)
2. CC re-launches: `node pokernow-bot/scripts/orchestrator.js`
3. New orchestrator auto-kills old PID if still zombie
4. All bots reconnect with existing cookies (session preserved)

### Zombie Process Cleanup
On startup, orchestrator checks `orchestrator.pid` and kills stale process.
SIGTERM → wait 3s → give up if still alive. Legacy bridge cleanup uses 2s wait.

### Shared Files (project root)

| File | Writer | Reader | Purpose |
|------|--------|--------|---------|
| `pending-turns.json` | orchestrator | CC | Which bots need decisions right now |
| `orchestrator-heartbeat.json` | orchestrator | CC | Is orchestrator alive? Bot status? |
| `orchestrator.pid` | orchestrator | orchestrator | Zombie detection |
| `game.json` | CC | orchestrator | Game config (deleted on shutdown) |

## Communication Files (per bot)

All in `PokerBot/bot_profiles/{botName}/`:

| File | Writer | Reader | Lifecycle |
|------|--------|--------|-----------|
| `turn.json` | orchestrator | CC | Ephemeral — deleted after action or hand end or process exit |
| `action.json` | CC | orchestrator | Ephemeral — deleted after execution |
| `state.json` | orchestrator | CC | Ephemeral — deleted on process exit |
| `history.jsonl` | orchestrator | CC | Persistent — kept for review/learning |
| `bridge.pid` | orchestrator | orchestrator | Ephemeral — deleted on process exit |
| `.cookies` | engine | engine | Persistent — player session identity |
| `personality.md` | CC/user | CC | Persistent — bot identity and strategy |

## Protocol Quick Reference

| Topic | Details |
|-------|---------|
| Action format | `42["action", {"type":"PLAYER_FOLD"}]` |
| Chat format | `42["new-message", "text"]` |
| Turn detect | `pITT == myId` in gC frame |
| Hand detect | `gN` increments each hand |
| Raise value | **Total bet**, between minRaise and maxRaise |
| Card encoding | `"{rank}{suit}"` — ranks: 2-9,T,J,Q,K,A — suits: d/h/c/s |
| Start game | HTTP POST `/games/{id}/start-game` |
| Approve player | HTTP POST `/games/{id}/approve_player` body: `{"playerID":"...","stackChange":1000}` |
| Remove player | HTTP POST `/games/{id}/remove_player` body: `{"playerID":"..."}` |
| Stop game | WS `42["action",{"type":"TSG","decision":true,"socket":true}]` |
| Pause/Resume | WS `42["action",{"type":"UP"/"UR","socket":true}]` |
| Next hand | WS `42["action",{"type":"NH","socket":true}]` |
