#!/bin/bash
# botmanager.sh — Bot Decision Executor (polling loop only)
# CC handles bot init + join. BotManager just polls and resumes sessions.
#
# Usage:
#   bash .claude/skills/bot-management/botmanager.sh --server localhost:3457 &
#   bash .claude/skills/bot-management/botmanager.sh --verbose

set +e  # Don't exit on errors — we handle them explicitly

PROJECT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$PROJECT_ROOT"

# Source pinned binary paths if present (PY / NODE / CLAUDE_BIN)
[ -f "$PROJECT_ROOT/paths.env" ] && source "$PROJECT_ROOT/paths.env"

# Portable timeout — Mac doesn't ship GNU `timeout`. Use perl fallback.
run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout &>/dev/null; then
    timeout "$secs" "$@"
  elif command -v gtimeout &>/dev/null; then
    gtimeout "$secs" "$@"
  else
    perl -e 'alarm shift @ARGV; exec @ARGV or die' "$secs" "$@"
  fi
}
PROMPT_TURN="$PROJECT_ROOT/.claude/skills/bot-management/botmanager-turn.md"
PID_FILE="$PROJECT_ROOT/.claude/skills/bot-management/.botmanager.pid"
LOG_FILE="$PROJECT_ROOT/.claude/skills/bot-management/.botmanager.log"

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
PROMPT_INIT="$PROJECT_ROOT/.claude/skills/bot-management/botmanager-init.md"

# Python (paths.env may have set $PY already)
PY="${PY:-python3}"
if ! $PY -c "print(1)" &>/dev/null; then
  log "ERROR: python3 not found at '$PY'. Edit paths.env."
  exit 1
fi
log "Using python: $PY"

# Claude CLI (paths.env may have set $CLAUDE_BIN already)
if [ -z "$CLAUDE_BIN" ]; then
  if command -v claude &>/dev/null; then
    CLAUDE_BIN="$(command -v claude)"
  elif [ -f "$HOME/.local/bin/claude" ]; then
    CLAUDE_BIN="$HOME/.local/bin/claude"
  fi
fi
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  log "ERROR: claude CLI not found at '$CLAUDE_BIN'. Edit paths.env or install Claude Code."
  exit 1
fi
log "Using claude CLI: $CLAUDE_BIN"

# ── Kill old BotManager if running ──
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "$$" ]; then
    log "Killing old BotManager (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
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
    if actor == 'CoachBot':
        pass  # Never treat CoachBot as a bot
    elif bots and actor in bots:
        print(actor)
    elif not bots and actor:
        import os
        profiles = os.path.join(sys.argv[3], '.claude', 'skills', 'bot-management', 'bots')
        bot_dir = os.path.join(profiles, actor)
        if os.path.isfile(os.path.join(bot_dir, 'personality.md')):
            print(actor)
except Exception:
    pass
" "$state" "$BOTS" "$PROJECT_ROOT" 2>/dev/null)
  echo "$actor"
}

# ── Helper: get model from personality.md ──
get_bot_model() {
  local bot="$1"
  local personality="$PROJECT_ROOT/.claude/skills/bot-management/bots/$bot/personality.md"
  if [ -f "$personality" ]; then
    sed -n 's/^- \*\*Model\*\*: \([[:alnum:]_-]*\).*/\1/p' "$personality" 2>/dev/null | head -1
  fi
}

# ── Helper: portable md5 hex digest (Mac `md5` / Linux `md5sum` differ).
# Uses `printf %s` (no trailing newline) to stay byte-compatible with
# the Node-side relay (poker-client.js deriveCoachSid) so bot and coach
# SIDs agree across shell pre-wipe and Node runtime.
_md5_hex() {
  if command -v md5sum &>/dev/null; then
    printf %s "$1" | md5sum | awk '{print $1}'
  else
    printf %s "$1" | md5
  fi
}

# ── Helper: generate deterministic session UUID from bot name ──
bot_session_id() {
  local bot="$1"
  _md5_hex "pokerbot-$bot" | sed 's/\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\).*/\1-\2-\3-\4-\5/'
}

# ── Session tracking (space-delimited list of initialized bot names) ──
# Using a flat string for bash 3.2 compat on Mac (assoc arrays need bash 4+)
BOT_SESSIONS=" "
bot_is_initialized() { [[ "$BOT_SESSIONS" == *" $1 "* ]]; }
bot_mark_initialized() { BOT_SESSIONS="$BOT_SESSIONS$1 "; }

# ── Helper: initialize a bot session ──
init_bot() {
  local bot="$1"
  local model="$2"
  local sid
  sid=$(bot_session_id "$bot")
  local model_flag=""
  if [ -n "$model" ]; then model_flag="--model $model"; fi

  # Bot sessions use a deterministic UUID per bot name. If the session
  # already exists from a prior run, claude CLI errors with "already in use"
  # — we treat that as "already initialized" and reuse the existing session.
  log "Initializing $bot (model: ${model:-default}, session: $sid)..."
  local result
  result=$(run_with_timeout 120 "$CLAUDE_BIN" -p "$(cat "$PROMPT_INIT")

SERVER_URL=$SERVER_URL
BOT_NAME=$bot" \
    --session-id "$sid" \
    $model_flag \
    --permission-mode bypassPermissions \
    2>&1) || true

  if echo "$result" | grep -qi "load successfully"; then
    bot_mark_initialized "$bot"
    log "✓ $bot initialized successfully"
    return 0
  elif echo "$result" | grep -qi "already in use"; then
    bot_mark_initialized "$bot"
    log "✓ $bot session already exists — reusing"
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

  run_with_timeout 90 "$CLAUDE_BIN" -p "$(cat "$PROMPT_TURN")

SERVER_URL=$SERVER_URL
BOT_NAME=$bot" \
    --resume "$sid" \
    $model_flag \
    --permission-mode bypassPermissions \
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
      if ! bot_is_initialized "$BOT"; then
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
        run_with_timeout 90 "$CLAUDE_BIN" -p "$(cat "$PROMPT_FILE")" \
          --permission-mode bypassPermissions \
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
