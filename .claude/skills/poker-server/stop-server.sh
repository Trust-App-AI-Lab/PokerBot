#!/bin/bash
# stop-server.sh — Stop poker-server (:3457) + relay (:3456)
# Only stops server infrastructure. For full shutdown (+ BotManager + orchestrator), use project root stop-game.sh.
log() { echo "[poker-server] $*"; }

# Helper: find PID listening on a port
find_pid_on_port() {
  if command -v lsof &>/dev/null; then
    lsof -ti:"$1" 2>/dev/null | head -1
  else
    netstat -ano 2>/dev/null | grep ":$1.*LISTEN" | awk '{print $NF}' | head -1
  fi
}

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
