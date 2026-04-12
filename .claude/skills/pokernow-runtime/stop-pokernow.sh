#!/bin/bash
# stop-pokernow.sh — Stop pokernow bridge + orchestrator + cleanup
# Only stops pokernow infrastructure. For full shutdown, use project root stop-game.sh.
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
log() { echo "[pokernow-runtime] $*"; }

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

# 1. Stop orchestrator
if [ -f "$SKILL_DIR/orchestrator.pid" ]; then
  PID=$(cat "$SKILL_DIR/orchestrator.pid" 2>/dev/null)
  if [ -n "$PID" ]; then
    kill_pid "$PID"
    log "Orchestrator stopped (PID $PID)"
  fi
  rm -f "$SKILL_DIR/orchestrator.pid"
else
  log "Orchestrator not running"
fi

# 2. Delete game.json to signal remaining pokernow processes
if [ -f "$SKILL_DIR/game.json" ]; then
  rm -f "$SKILL_DIR/game.json"
  log "game.json deleted (signal cleanup)"
elif [ -f "$PROJECT_ROOT/game.json" ]; then
  rm -f "$PROJECT_ROOT/game.json"
  log "game.json deleted from project root (signal cleanup)"
fi

# 3. Stop bridge on port 3456
BRIDGE_PID=$(find_pid_on_port 3456)
if [ -n "$BRIDGE_PID" ]; then
  kill_pid "$BRIDGE_PID"
  log "Bridge stopped (PID $BRIDGE_PID)"
else
  log "Bridge not running"
fi

log "All stopped."
