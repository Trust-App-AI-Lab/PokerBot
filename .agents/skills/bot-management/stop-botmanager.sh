#!/bin/bash
# stop-botmanager.sh — Stop BotManager process
# Only stops BotManager. For full shutdown, use project root stop-game.sh.
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
PID_FILE="$SKILL_DIR/.botmanager.pid"
log() { echo "[bot-management] $*"; }

is_own_botmanager_pid() {
  local pid="$1"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null || return 1
  local command
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [ -n "$command" ] || return 1
  case "$command" in
    *"$PROJECT_ROOT/.agents/skills/bot-management/botmanager.sh"*|*"$PROJECT_ROOT/.agents/skills/bot-management/botmanager.js"*) return 0 ;;
  esac
  return 1
}

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$PID" ]; then
    if is_own_botmanager_pid "$PID"; then
      kill -9 "$PID" 2>/dev/null
      log "BotManager stopped (PID $PID)"
    else
      log "PID file points at PID $PID, but it is not this project's BotManager; leaving it alone"
    fi
  fi
  rm -f "$PID_FILE"
else
  log "BotManager not running"
fi
