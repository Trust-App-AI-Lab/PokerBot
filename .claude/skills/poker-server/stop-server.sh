#!/bin/bash
# stop-server.sh — Stop poker-server (:3457) + relay (:3456)
# Only stops server infrastructure. For full shutdown (+ BotManager + orchestrator), use .claude/skills/game/stop-game.sh.
log() { echo "[poker-server] $*"; }

find_pid_on_port() {
  lsof -ti:"$1" 2>/dev/null | head -1
}

kill_pid() {
  local pid="$1"
  [ -z "$pid" ] && return 1
  kill -9 "$pid" 2>/dev/null
}

# 0. Stop narrator on port 3460 (if running)
NARRATOR_PID=$(find_pid_on_port 3460)
if [ -n "$NARRATOR_PID" ]; then
  kill_pid "$NARRATOR_PID"
  log "Narrator stopped (PID $NARRATOR_PID)"
else
  log "Narrator not running"
fi

# 1. Stop relay on port 3456
RELAY_PID=$(find_pid_on_port 3456)
if [ -n "$RELAY_PID" ]; then
  kill_pid "$RELAY_PID"
  log "Relay stopped (PID $RELAY_PID)"
else
  log "Relay not running"
fi

# 2. Stop server on port 3457
SERVER_PID=$(find_pid_on_port 3457)
if [ -n "$SERVER_PID" ]; then
  kill_pid "$SERVER_PID"
  log "Server stopped (PID $SERVER_PID)"
else
  log "Server not running"
fi

log "All stopped."
