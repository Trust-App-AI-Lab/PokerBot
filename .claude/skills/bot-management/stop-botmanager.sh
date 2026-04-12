#!/bin/bash
# stop-botmanager.sh — Stop BotManager process
# Only stops BotManager. For full shutdown, use project root stop-game.sh.
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SKILL_DIR/.botmanager.pid"
log() { echo "[bot-management] $*"; }

# Helper: kill a process reliably (cross-platform)
kill_pid() {
  local pid="$1"
  [ -z "$pid" ] && return 1
  if command -v taskkill &>/dev/null; then
    taskkill //PID "$pid" //F > /dev/null 2>&1
  else
    kill -9 "$pid" 2>/dev/null
  fi
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
