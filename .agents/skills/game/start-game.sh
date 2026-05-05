#!/bin/bash
# start-game.sh — PokerBot launcher (full stack, one command).
#
# Launches: server(:3457) + relay(:3456) + narrator(:3460)
#           + bots + BotManager + CoachBot pre-warm + optional local URL open.
#
# The server boots with phase=waiting — host clicks Start in the table UI
# (or runs `curl -X POST :3457/start`) to deal the first hand.
#
# Usage:
#   bash .agents/skills/game/start-game.sh [flags]           # default: start or attach if already running
#   bash .agents/skills/game/start-game.sh stop              # kill everything
#   bash .agents/skills/game/start-game.sh restart [flags]   # stop then start
#
# Flags:
#   --name <Name>       your in-game name (default: $USER)
#   --bots "A,B"        comma-separated bot names (default: all non-template bots)
#   --auto              narrator starts in auto-play mode (CoachBot decides for you)
#   --lang zh|en        narrator language (default: en)
#   --public            expose server on 0.0.0.0 for LAN play
#   --no-open           skip auto-opening the local URL; Desktop opens the app window itself
#   --no-botmanager     human-only table, no bot decisions
#   --no-coach          skip CoachBot pre-warm (bot-vs-bot testing only)

set -e
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
log() { echo "[Game] $*"; }

# Source pinned binary paths if present (PY / NODE / CODEX_BIN)
[ -f "$PROJECT_ROOT/paths.env" ] && source "$PROJECT_ROOT/paths.env"
NODE="${NODE:-node}"
CODEX_AGENT="$PROJECT_ROOT/scripts/codex-agent.js"

# ── Subcommand dispatch ──
CMD="start"
case "${1:-}" in
  stop)    CMD="stop";    shift ;;
  restart) CMD="restart"; shift ;;
  start)   CMD="start";   shift ;;
esac

# ── Defaults ──
NAME="${USER:-}"
BOTS=""
AUTO=false
LANG_TAG="en"
PUBLIC=""
OPEN_BROWSER=true
START_BM=true
START_COACH=true

# ── Parse args ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)          NAME="$2"; shift 2 ;;
    --bots)          BOTS="$2"; shift 2 ;;
    --auto)          AUTO=true; shift ;;
    --lang)          LANG_TAG="$2"; shift 2 ;;
    --public)        PUBLIC="--public"; shift ;;
    --no-open)       OPEN_BROWSER=false; shift ;;
    --no-botmanager) START_BM=false; shift ;;
    --no-coach)      START_COACH=false; shift ;;
    -h|--help)       sed -n '3,22p' "$0"; exit 0 ;;
    *)               shift ;;
  esac
done

stop_all() {
  log "Stopping all PokerBot processes..."
  bash "$SKILL_DIR/stop-game.sh" 2>/dev/null || true
  log "Stopped."
}

if [ "$CMD" = "stop" ]; then
  stop_all
  exit 0
fi

if [ "$CMD" = "restart" ]; then
  stop_all
  sleep 1
fi

[ -z "$NAME" ] && { log "ERROR: --name required"; exit 1; }

pid_alive() {
  local file="$1"
  [ -f "$file" ] || return 1
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

SERVER_PID_FILE="$PROJECT_ROOT/.agents/skills/poker-server/.server.pid"
RELAY_PID_FILE="$PROJECT_ROOT/.agents/skills/poker-server/.relay.pid"
NARRATOR_PID_FILE="$PROJECT_ROOT/.agents/skills/poker-server/.narrator.pid"

if [ "$CMD" = "start" ] && pid_alive "$SERVER_PID_FILE" && pid_alive "$RELAY_PID_FILE"; then
  log "PokerBot is already running; attaching to the existing app runtime instead of stopping it."
  if $AUTO && pid_alive "$NARRATOR_PID_FILE"; then
    curl -s -X POST localhost:3460/mode -H "Content-Type: application/json" -d '{"mode":"auto"}' >/dev/null 2>&1 || true
    log "Narrator mode → auto"
  fi
  if $OPEN_BROWSER; then
    URL="http://localhost:3456"
    if command -v open &>/dev/null; then
      open "$URL" 2>/dev/null || true
    elif command -v xdg-open &>/dev/null; then
      xdg-open "$URL" 2>/dev/null || true
    fi
  fi
  log "Existing app: http://localhost:3456"
  log "Use 'restart' or 'stop' explicitly to replace/stop the running game."
  exit 0
fi

# ── Helpers: logical Codex session wipe (fresh thread per game) ──
wipe_session() {
  local session_key="$1"
  "$NODE" "$CODEX_AGENT" --reset --session-key "$session_key" >/dev/null 2>&1 || true
}

# ── 0. Full cleanup ──
log "Stopping old processes..."
bash "$SKILL_DIR/stop-game.sh"
sleep 1

# ── 1. Write user name file + start server (delegates to poker-server) ──
# Relay reads game-data/.current-user when it launches, so write it first.
mkdir -p "$PROJECT_ROOT/game-data"
echo -n "$NAME" > "$PROJECT_ROOT/game-data/.current-user"

PUBLIC_FLAG=""
[ -n "$PUBLIC" ] && PUBLIC_FLAG="--public"
bash "$PROJECT_ROOT/.agents/skills/poker-server/start-server.sh" --name "$NAME" $PUBLIC_FLAG
if [ $? -ne 0 ]; then
  log "ERROR: server startup failed"
  exit 1
fi

# ── 2. Discover + join bots ──
if [ -n "$BOTS" ]; then
  IFS=',' read -ra BOT_LIST <<< "$BOTS"
else
  BOT_LIST=()
  for dir in "$PROJECT_ROOT"/.agents/skills/bot-management/bots/*/; do
    bname=$(basename "$dir")
    [ "$bname" = ".template" ] && continue
    [ -f "$dir/personality.md" ] && BOT_LIST+=("$bname")
  done
fi

for bot in "${BOT_LIST[@]}"; do
  r=$(curl -s -X POST localhost:3457/join -H "Content-Type: application/json" -d "{\"name\":\"$bot\"}" 2>/dev/null)
  echo "$r" | grep -q '"ok"' && log "+ $bot" || log "~ $bot already in"
done

# ── 3. Wipe stale sessions (fresh session per game) ──
for bot in "${BOT_LIST[@]}"; do
  wipe_session "pokerbot-$bot"
done
COACH_SESSION_KEY="coachbot-$NAME"
wipe_session "$COACH_SESSION_KEY"

# ── 4. CoachBot pre-warm (independent session, resumed per analysis) ──
if $START_COACH; then
  if [ ! -x "$CODEX_AGENT" ]; then
    log "ERROR: Codex adapter missing at $CODEX_AGENT"
    exit 1
  fi
  # Single source of truth for CoachBot's model: `model:` in coachbot/SKILL.md
  # frontmatter. Same file is parsed by poker-client.js::readCoachModel so
  # both paths stay in sync. Defaults to gpt-5.4 if the field is missing.
  COACH_SKILL_MD="$PROJECT_ROOT/.agents/skills/coachbot/SKILL.md"
  COACH_MODEL=$(awk '/^---$/{i++;next} i==1 && /^model:[[:space:]]/{sub(/^model:[[:space:]]*/,""); sub(/[[:space:]]+$/,""); print; exit}' "$COACH_SKILL_MD" 2>/dev/null)
  COACH_MODEL="${COACH_MODEL:-gpt-5.4}"
  log "CoachBot pre-warming (session: $COACH_SESSION_KEY, model: $COACH_MODEL)..."
  COACH_INIT_PROMPT="Read .agents/skills/coachbot/SKILL.md and follow it throughout this session. Also read .agents/skills/poker-strategy/SKILL.md (the tiny router — tool + doc index). Do NOT bulk-load the strategy docs; per-turn you will Read individual docs on-demand when the spot touches them. When done, reply exactly: load successfully"
  COACH_OUT=$("$NODE" "$CODEX_AGENT" \
    --session-key "$COACH_SESSION_KEY" \
    --model "$COACH_MODEL" \
    "$COACH_INIT_PROMPT" 2>&1) || true
  if echo "$COACH_OUT" | grep -qi "load successfully"; then
    log "✓ CoachBot ready"
  else
    log "✗ CoachBot init failed — last output:"
    echo "$COACH_OUT" | tail -5 | sed 's/^/    /'
    log "  (game will continue without CoachBot pre-warm; relay will lazy-init on first ask)"
  fi
fi

# ── 5. Start BotManager (event-driven: subscribes to server WS :3457) ──
if $START_BM && [ ${#BOT_LIST[@]} -gt 0 ]; then
  BM_LOG="$PROJECT_ROOT/game-data/botmanager.log"
  mkdir -p "$(dirname "$BM_LOG")"
  BM_PID=$("$NODE" "$PROJECT_ROOT/scripts/detached-spawn.js" \
    --cwd "$PROJECT_ROOT" \
    --stdout "$BM_LOG" \
    --stderr "$BM_LOG" \
    -- "$NODE" "$PROJECT_ROOT/.agents/skills/bot-management/botmanager.js" \
    --server http://localhost:3457 \
  )
  sleep 1
  log "BotManager started (PID $(cat "$PROJECT_ROOT/.agents/skills/bot-management/.botmanager.pid" 2>/dev/null || echo "$BM_PID")) — log: $BM_LOG"
fi

# ── 6. Start relay (:3456) ──
RELAY_LOG="$PROJECT_ROOT/game-data/relay.log"
mkdir -p "$(dirname "$RELAY_LOG")"
log "Starting relay on :3456..."
RELAY_PID=$("$NODE" "$PROJECT_ROOT/scripts/detached-spawn.js" \
  --cwd "$PROJECT_ROOT" \
  --stdout "$RELAY_LOG" \
  --stderr "$RELAY_LOG" \
  --env "POKER_USER=$NAME" \
  -- "$NODE" "$PROJECT_ROOT/.agents/skills/poker-server/poker-client.js" ws://localhost:3457 --name "$NAME" --port 3456)
echo "$RELAY_PID" > "$PROJECT_ROOT/.agents/skills/poker-server/.relay.pid"
for i in $(seq 1 10); do
  curl -s --max-time 1 http://localhost:3456/state >/dev/null 2>&1 && { log "Relay up (PID $RELAY_PID, log: $RELAY_LOG)"; break; }
  [ "$i" -eq 10 ] && { log "ERROR: relay failed to start — see $RELAY_LOG"; exit 1; }
  sleep 1
done

# ── 7. Start narrator (:3460) ──
NARRATOR_LOG="$PROJECT_ROOT/game-data/narrator.log"
NARRATOR_ARGS=( --relay http://localhost:3456 --port 3460 --lang "$LANG_TAG" )
$AUTO && NARRATOR_ARGS+=( --auto )
log "Starting narrator on :3460 (mode=$($AUTO && echo auto || echo manual), lang=$LANG_TAG)..."
NARRATOR_PID=$("$NODE" "$PROJECT_ROOT/scripts/detached-spawn.js" \
  --cwd "$PROJECT_ROOT" \
  --stdout "$NARRATOR_LOG" \
  --stderr "$NARRATOR_LOG" \
  -- "$NODE" "$PROJECT_ROOT/.agents/skills/poker-server/narrator.js" "${NARRATOR_ARGS[@]}")
echo "$NARRATOR_PID" > "$PROJECT_ROOT/.agents/skills/poker-server/.narrator.pid"
for i in $(seq 1 10); do
  curl -s --max-time 1 http://localhost:3460/mode >/dev/null 2>&1 && { log "Narrator up (PID $NARRATOR_PID, log: $NARRATOR_LOG)"; break; }
  [ "$i" -eq 10 ] && { log "WARN: narrator didn't respond on :3460 — see $NARRATOR_LOG"; }
  sleep 1
done

# ── 8. Open local URL for CLI runs ──
if $OPEN_BROWSER; then
  URL="http://localhost:3456"
  if command -v open &>/dev/null; then
    open "$URL" 2>/dev/null || true
  elif command -v xdg-open &>/dev/null; then
    xdg-open "$URL" 2>/dev/null || true
  fi
  log "Local table → $URL"
fi

log "Ready! (CoachBot session: $COACH_SESSION_KEY)"

# ── Summary ──
cat <<EOF
[PokerBot] ────────────────────────────────────────
  name:     $NAME
  server:   http://localhost:3457
  relay:    http://localhost:3456   ← Desktop app window / local table UI
  narrator: http://localhost:3460   (mode=$($AUTO && echo auto || echo manual))

  Deal the first hand (or click Start in the table UI):
    curl -s -X POST localhost:3457/start -H "Content-Type: application/json" -d '{}'

  Switch narrator mode:
    curl -s -X POST localhost:3460/mode -H "Content-Type: application/json" -d '{"mode":"auto"}'
    curl -s -X POST localhost:3460/mode -H "Content-Type: application/json" -d '{"mode":"manual"}'

  Stop everything:
    bash .agents/skills/game/start-game.sh stop
────────────────────────────────────────────────────
EOF
