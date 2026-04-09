# BotManager — Bot Decision Engine

BotManager runs as a **background process** alongside the main CC session.
It polls for bot turns every 2s and invokes `claude -p --resume` to make decisions.

## Architecture

```
CC (CoachBot) — manager:              BotManager (botmanager.sh) — executor:
  ├─ Create personality.md              ├─ Poll GET /state every 2s
  ├─ Init session (claude -p)           ├─ currentActor is a bot?
  ├─ POST /join to server               └─ Yes → claude -p --resume → POST /action
  └─ Full control: who, when
```

**CC owns the lifecycle.** BotManager is a stateless polling loop — it only acts when a bot it recognizes is `currentActor`. No init, no join, no management logic.

## Session Architecture (Init + Resume)

Each bot has a **persistent session** identified by a deterministic UUID derived from its name.

**Init** (done by CC, once per bot):
```bash
claude -p "$(cat botmanager-init.md) ..." \
  --session-id "<uuid>" \
  --model <model> \
  --allowedTools "Read,Glob,Grep,Bash(curl *),Bash(py *)"
```
- Loads personality.md + strategy docs based on skill level
- Bot confirms "load successfully"
- Session persists — survives BotManager restarts

**Turn** (done by BotManager, every turn):
```bash
claude -p "$(cat botmanager-turn.md) ..." \
  --resume "<uuid>" \
  --model <model> \
  --allowedTools "Bash(curl *),Bash(py *)"
```
- Hot resume — personality + strategy already in context
- Read state → run GTO tools → decide → POST /action → EXIT
- ~8-10s per turn

## Session ID Convention

```bash
echo "pokerbot-$BOT_NAME" | md5sum | sed 's/\(.\{8\}\)...'
# e.g. "pokerbot-Shark_Alice" → "a1b2c3d4-e5f6-..."
```

Deterministic from bot name only. Both CC and BotManager use the same function, so CC's init and BotManager's resume target the same session.

## Tool Permissions

| Phase | Allowed Tools | Why |
|-------|--------------|-----|
| Init | `Read,Glob,Grep,Bash(curl *),Bash(py *)` | Needs to read personality.md + strategy files |
| Turn | `Bash(curl *),Bash(py *)` | Only curl for state/action + py for GTO tools |

Bots cannot: write files, read other bots, execute arbitrary commands.

## Model Assignment

Each bot's `personality.md` has a `Model` field:

| Model | Cost | Speed | Best for |
|-------|------|-------|----------|
| haiku | $ | ~5-8s | Fish, regulars. Natural mistakes. |
| sonnet | $$ | ~10-15s | Sharks, solid players. Good balance. |
| opus | $$$ | ~20-30s | GTO pros. Strongest reasoning. |

## Prompt Files

- `botmanager-init.md` — Init prompt: load personality + strategy, confirm ready
- `botmanager-turn.md` — Turn prompt: read state, decide, submit action, EXIT

## Information Isolation

- Server `/state?player=X` only shows that player's own hole cards
- Turn prompt has NO file paths, NO directory names, NO other bot names
- Each bot's session is isolated — cannot see other bots' context
- CoachBot sees user's cards via relay, but this never enters any bot's session

## Launching

```bash
# BotManager — just the polling loop, no init/join
bash bot_profiles/botmanager.sh --server http://localhost:3457 &

# Exits automatically when server stops
# Manual stop: kill $(cat botmanager.pid)
```

## File Mode (pokernow fallback)

File mode uses cold-start `claude -p` per batch (no session resume).
Polls `pending-turns.json`, writes `action.json`. See `botmanager-init.md` + `botmanager-turn.md`.
