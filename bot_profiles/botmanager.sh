#!/bin/bash
# botmanager.sh — Bot Decision Executor (polling loop only)
# CC handles bot init + join. BotManager just polls and resumes sessions.
#
# Usage:
#   bash bot_profiles/botmanager.sh --server localhost:3457 &
#   bash bot_profiles/botmanager.sh --verbose

set +e  # Don't exit on errors — we handle them explicitly

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_TURN="$PROJECT_ROOT/bot_profiles/botmanager-turn.md"
PID_FILE="$PROJECT_ROOT/bot_profiles/.botmanager.pid"
LOG_FILE="$PROJECT_ROOT/bot_profiles/.botmanager.log"

# ── Defaults ──
SERVER_URL=""
VERBOSE=false
BOTS=""

# ── Parse args ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)  SERVER_URL="$2"; shift 2 ;;
    --bots)    BOTS="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    *)         shift ;;
  esac
done

log() { echo "[BotManager] $(date '+%H:%M:%S') $*"; }
debug() { $VERBOSE && log "[DEBUG] $*" || true; }

# ── Auto-detect mode ──
if [ -z "$SERVER_URL" ]; then
  if curl -s --max-time 1 http://localhost:3457/info >/dev/null 2>&1; then
    SERVER_URL="http://localhost:3457"
    log "Detected poker-server at $SERVER_URL → HTTP mode"
  fi
fi

if [ -n "$SERVER_URL" ]; then
  MODE="http"
else
  MODE="file"
  PENDING="$PROJECT_ROOT/pending-turns.json"
  GAME="$PROJECT_ROOT/game.json"
fi

log "Mode: $MODE"

# ── Pre-flight checks ──
if [ "$MODE" = "file" ] && [ ! -f "$GAME" ]; then
  log "ERROR: game.json not found (file mode). Write game.json first."
  exit 1
fi

# Find working python
PY=""
for cmd in py python python3; do
  if $cmd -c "print(1)" &>/dev/null; then PY="$cmd"; break; fi
done
if [ -z "$PY" ]; then
  log "ERROR: No working python found."
  exit 1
fi
log "Using python: $PY"

# Find claude CLI
CLAUDE_BIN=""
if command -v claude &>/dev/null; then
  CLAUDE_BIN="claude"
elif [ -f "$HOME/.local/bin/claude.exe" ]; then
  CLAUDE_BIN="$HOME/.local/bin/claude.exe"
elif [ -f "$HOME/.local/bin/claude" ]; then
  CLAUDE_BIN="$HOME/.local/bin/claude"
fi

if [ -z "$CLAUDE_BIN" ]; then
  log "ERROR: claude CLI not found. Install Claude Code first."
  exit 1
fi
log "Using claude CLI: $CLAUDE_BIN"

# ── Kill old BotManager if running ──
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "$$" ]; then
    log "Killing old BotManager (PID $OLD_PID)..."
    if command -v taskkill &>/dev/null; then
      taskkill //PID "$OLD_PID" //F > /dev/null 2>&1 || true
    else
      kill "$OLD_PID" 2>/dev/null || true
    fi
    sleep 1
  fi
fi

echo $$ > "$PID_FILE"
log "Started (PID $$). Watching for bot turns..."

# ── Helper: check if game is still running ──
game_alive() {
  if [ "$MODE" = "http" ]; then
    curl -s --max-time 2 "$SERVER_URL/info" >/dev/null 2>&1
  else
    [ -f "$GAME" ]
  fi
}

# ── Helper: check if a bot needs to act (HTTP mode) ──
check_bot_turn_http() {
  local state
  state=$(curl -s --max-time 2 "$SERVER_URL/state" 2>/dev/null) || return
  local actor
  actor=$($PY -c "
import json, sys
try:
    s = json.loads(sys.argv[1])
    actor = s.get('currentActor', '')
    bots = sys.argv[2].split(',') if sys.argv[2] else []
    if bots and actor in bots:
        print(actor)
    elif not bots and actor:
        import os
        profiles = os.path.join(sys.argv[3], 'bot_profiles')
        bot_dir = os.path.join(profiles, actor)
        if os.path.isfile(os.path.join(bot_dir, 'personality.md')):
            if actor != 'CoachBot':
                print(actor)
except Exception:
    pass
" "$state" "$BOTS" "$PROJECT_ROOT" 2>/dev/null)
  echo "$actor"
}

# ── Helper: get model from personality.md ──
get_bot_model() {
  local bot="$1"
  local personality="$PROJECT_ROOT/bot_profiles/$bot/personality.md"
  if [ -f "$personality" ]; then
    grep -oP '^\- \*\*Model\*\*: \K\w+' "$personality" 2>/dev/null || true
  fi
}

# ── Helper: generate deterministic session UUID from bot name ──
bot_session_id() {
  local bot="$1"
  # Generate a stable UUID from bot name only — survives BotManager restarts
  echo "pokerbot-$bot" | md5sum | sed 's/\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\).*/\1-\2-\3-\4-\5/'
}

# ── Associative array for session tracking ──
declare -A BOT_SESSIONS  # bot_name → "initialized" or ""

# ── Helper: initialize a bot session ──
init_bot() {
  local bot="$1"
  local model="$2"
  local sid
  sid=$(bot_session_id "$bot")
  local model_flag=""
  if [ -n "$model" ]; then model_flag="--model $model"; fi

  # Try to resume existing session first
  local probe
  probe=$(timeout 15 "$CLAUDE_BIN" -p "Say exactly: session alive" \
    --resume "$sid" $model_flag \
    --allowedTools "Bash(echo *)" \
    2>/dev/null) || true
  if echo "$probe" | grep -qi "session alive"; then
    BOT_SESSIONS["$bot"]="initialized"
    log "✓ $bot session resumed (already initialized)"
    return 0
  fi

  log "Initializing $bot (model: ${model:-default}, session: $sid)..."
  local result
  result=$(timeout 120 "$CLAUDE_BIN" -p "$(cat "$PROMPT_INIT")

SERVER_URL=$SERVER_URL
BOT_NAME=$bot" \
    --session-id "$sid" \
    $model_flag \
    --allowedTools "Read,Glob,Grep,Bash(curl *),Bash(python *),Bash(python3 *),Bash(py *)" \
    2>> "$LOG_FILE") || true

  if echo "$result" | grep -qi "load successfully"; then
    BOT_SESSIONS["$bot"]="initialized"
    log "✓ $bot initialized successfully"
    return 0
  else
    log "✗ $bot init failed: $result"
    return 1
  fi
}

# ── Helper: invoke bot turn via resume ──
invoke_bot_turn() {
  local bot="$1"
  local model="$2"
  local sid
  sid=$(bot_session_id "$bot")
  local model_flag=""
  if [ -n "$model" ]; then model_flag="--model $model"; fi

  timeout 90 "$CLAUDE_BIN" -p "$(cat "$PROMPT_TURN")

SERVER_URL=$SERVER_URL
BOT_NAME=$bot" \
    --resume "$sid" \
    $model_flag \
    --allowedTools "Bash(curl *),Bash(python *),Bash(python3 *),Bash(py *)" \
    2>> "$LOG_FILE" || log "WARN: claude -p exited with error for $bot"
}

# ── Main loop ──
log "Polling for bot turns... (CC handles bot init + join)"
while game_alive; do
  if [ "$MODE" = "http" ]; then
    BOT=$(check_bot_turn_http)
    if [ -n "$BOT" ]; then
      BOT_MODEL=$(get_bot_model "$BOT")

      # Init if not yet initialized (fallback for failed pre-init)
      if [ "${BOT_SESSIONS[$BOT]:-}" != "initialized" ]; then
        init_bot "$BOT" "$BOT_MODEL" || continue
      fi

      log "Bot turn: $BOT (model: ${BOT_MODEL:-default}) — resuming session"
      invoke_bot_turn "$BOT" "$BOT_MODEL"
      debug "claude -p completed for $BOT"
    else
      debug "No bot turn pending"
    fi
  else
    # File mode (pokernow fallback) — unchanged, uses cold-start
    if [ -f "$PENDING" ]; then
      COUNT=$($PY -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get('count', 0))
except Exception:
    print(0)
" "$PENDING" 2>/dev/null || echo "0")

      if [ "$COUNT" -gt "0" ]; then
        log "$COUNT pending turn(s) — invoking claude -p"
        timeout 90 "$CLAUDE_BIN" -p "$(cat "$PROMPT_FILE")" \
          --allowedTools "Read,Write,Edit,Glob,Grep,Agent,Bash(python *),Bash(python3 *)" \
          2>> "$LOG_FILE" || log "WARN: claude -p exited with error (see $LOG_FILE)"
        debug "claude -p completed"
      else
        debug "No pending turns (count=$COUNT)"
      fi
    else
      debug "pending-turns.json not found"
    fi
  fi

  sleep 2
done

log "Game ended — exiting."
rm -f "$PID_FILE"
