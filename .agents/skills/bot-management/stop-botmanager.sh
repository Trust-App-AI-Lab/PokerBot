#!/bin/bash
# stop-botmanager.sh — Stop BotManager process
# Only stops BotManager. For full shutdown, use project root stop-game.sh.
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SKILL_DIR/.botmanager.pid"
log() { echo "[bot-management] $*"; }

kill_pid() {
  local pid="$1"
  [ -z "$pid" ] && return 1
  kill -9 "$pid" 2>/dev/null
}

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$PID" ]; then
    kill_pid "$PID"
    log "BotManager stopped (PID $PID)"
  fi
  rm -f "$PID_FILE"
else
  log "BotManager not running"
fi
