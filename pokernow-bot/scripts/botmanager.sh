#!/bin/bash
# botmanager.sh — BotManager outer loop
# Polls pending-turns.json every 2s, invokes claude -p for each batch of turns.
# Exits when game.json is deleted.
#
# Usage:
#   bash scripts/botmanager.sh &          # from pokernow-bot/
#   bash scripts/botmanager.sh --verbose   # with debug output

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PENDING="$PROJECT_ROOT/pending-turns.json"
GAME="$PROJECT_ROOT/game.json"
PROMPT="$PROJECT_ROOT/pokernow-bot/scripts/botmanager-prompt.md"
PID_FILE="$PROJECT_ROOT/botmanager.pid"
LOG_FILE="$PROJECT_ROOT/botmanager.log"

VERBOSE=false
[[ "${1:-}" == "--verbose" ]] && VERBOSE=true

log() { echo "[BotManager] $(date '+%H:%M:%S') $*"; }
debug() { $VERBOSE && log "[DEBUG] $*" || true; }

# ── Pre-flight checks ───────────────────────────
if [ ! -f "$GAME" ]; then
  log "ERROR: game.json not found. Write game.json first."
  exit 1
fi

if [ ! -f "$PROMPT" ]; then
  log "ERROR: botmanager-prompt.md not found at $PROMPT"
  exit 1
fi

if ! command -v claude &>/dev/null; then
  log "ERROR: claude CLI not found. Install Claude Code first."
  exit 1
fi

# ── Kill old BotManager if running ───────────────
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log "Killing old BotManager (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

echo $$ > "$PID_FILE"
log "Started (PID $$). Watching for pending turns..."

# ── Main loop ────────────────────────────────────
while [ -f "$GAME" ]; do
  if [ -f "$PENDING" ]; then
    COUNT=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get('count', 0))
except Exception:
    print(0)
" "$PENDING" 2>/dev/null || echo "0")

    if [ "$COUNT" -gt "0" ]; then
      log "$COUNT pending turn(s) — invoking claude -p"
      timeout 90 claude -p "$(cat "$PROMPT")" \
        --allowedTools "Read,Write,Edit,Glob,Grep,Agent,Bash(python *),Bash(python3 *)" \
        2>> "$LOG_FILE" || log "WARN: claude -p exited with error (see $LOG_FILE)"
      debug "claude -p completed"
    else
      debug "No pending turns (count=$COUNT)"
    fi
  else
    debug "pending-turns.json not found"
  fi

  sleep 2
done

log "game.json deleted — exiting."
rm -f "$PID_FILE"
