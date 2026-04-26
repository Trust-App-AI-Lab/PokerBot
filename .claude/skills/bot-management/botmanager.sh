#!/bin/bash
# botmanager.sh — Bot Decision Executor (polling loop, file-mode fallback)
#
# ⚠ HTTP mode has moved to botmanager.js (event-driven WS subscription).
#   start-game.sh now launches botmanager.js by default.
#   This script remains for:
#     - file mode (pokernow runtime writes pending-turns.json)
#     - manual debugging when Node isn't available
#   The HTTP-mode branch below still works but is no longer the canonical path.
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
BOTS_DIR="$PROJECT_ROOT/.claude/skills/bot-management/bots"
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

# ── Helpers: extract model from frontmatter + strip frontmatter for body ──
# Frontmatter: YAML between the first two --- fences. Only `model` is read.
# Everything after the 2nd fence is the personality body (character + toolkit).
get_bot_model() {
  local path="$BOTS_DIR/$1/personality.md"
  [ -f "$path" ] || return 1
  awk 'BEGIN{fm=0} /^---$/{fm++; next} fm==1 && /^model:/{sub(/^model:[[:space:]]*/,""); print; exit}' "$path"
}
get_bot_body() {
  local path="$BOTS_DIR/$1/personality.md"
  [ -f "$path" ] || return 1
  awk 'BEGIN{fm=0} /^---$/{fm++; next} fm>=2' "$path"
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

# ── Session tracking ──
# Once a bot has had its first turn, we use --resume on subsequent turns so
# in-game observations (previous hands, opponent reads) carry forward.
# The full turn prompt (turn.md + personality body) is re-injected every turn —
# memory drift over a long game can't erode what's re-stated each turn.
BOT_SESSIONS=" "
bot_has_session()   { [[ "$BOT_SESSIONS" == *" $1 "* ]]; }
bot_mark_session()  { BOT_SESSIONS="$BOT_SESSIONS$1 "; }

# ── Helper: build the per-turn prompt for a bot ──
# Assembly: turn.md + personality body (= character + pre-rendered toolkit) + state + env.
# State JSON is fetched here (not by the bot) — BotManager already polls /state to know
# it's this bot's turn, so we just re-fetch with ?player=$bot to get the hole-cards view
# and push it in the prompt. Bot never curls /state itself. All tool/doc descriptions
# live in each personality.md — script stays pure concat + one state fetch.
build_turn_prompt() {
  local bot="$1"
  local body state
  body=$(get_bot_body "$bot") || return 1
  state=$(curl -s --max-time 2 "$SERVER_URL/state?player=$bot" 2>/dev/null)
  [ -z "$state" ] && { log "✗ /state fetch empty for $bot"; return 1; }

  cat "$PROMPT_TURN"
  echo
  echo "---"
  echo
  echo "$body"
  echo
  echo "---"
  echo
  echo "SERVER_URL=$SERVER_URL"
  echo "BOT_NAME=$bot"
  echo
  echo "## State"
  echo
  echo '```json'
  echo "$state"
  echo '```'
}

# ── Helper: invoke a bot turn ──
# First turn for a bot: creates session with --session-id (no --resume).
# Subsequent turns: uses --resume to continue the session.
# Personality body + router are re-injected in the prompt every turn regardless.
invoke_bot_turn() {
  local bot="$1"
  local model="$2"
  local sid
  sid=$(bot_session_id "$bot")
  local model_flag=""
  if [ -n "$model" ]; then model_flag="--model $model"; fi

  local prompt
  prompt=$(build_turn_prompt "$bot") || { log "✗ build_turn_prompt failed for $bot"; return 1; }

  local session_flag
  if bot_has_session "$bot"; then
    session_flag="--resume $sid"
  else
    session_flag="--session-id $sid"
  fi

  run_with_timeout 120 "$CLAUDE_BIN" -p "$prompt" \
    $session_flag \
    $model_flag \
    --permission-mode bypassPermissions \
    2>> "$LOG_FILE"
  local rc=$?

  # First turn: if session-id conflict (session already exists from prior run),
  # retry with --resume. This keeps cross-run continuity when BotManager restarts
  # mid-game.
  if [ $rc -ne 0 ] && ! bot_has_session "$bot"; then
    if tail -20 "$LOG_FILE" | grep -qi "already in use"; then
      log "Session $sid exists — retrying $bot with --resume"
      run_with_timeout 120 "$CLAUDE_BIN" -p "$prompt" \
        --resume "$sid" \
        $model_flag \
        --permission-mode bypassPermissions \
        2>> "$LOG_FILE"
      rc=$?
    fi
  fi

  if [ $rc -eq 0 ]; then
    bot_mark_session "$bot"
  else
    log "WARN: claude -p exited with error ($rc) for $bot"
  fi
}

# ── Main loop ──
log "Polling for bot turns... (CC handles bot init + join)"
while game_alive; do
  if [ "$MODE" = "http" ]; then
    BOT=$(check_bot_turn_http)
    if [ -n "$BOT" ]; then
      BOT_MODEL=$(get_bot_model "$BOT")

      if bot_has_session "$BOT"; then
        log "Bot turn: $BOT (model: ${BOT_MODEL:-default}) — resume + fresh framework"
      else
        log "Bot turn: $BOT (model: ${BOT_MODEL:-default}) — first turn, creating session"
      fi
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
