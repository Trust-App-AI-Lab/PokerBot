#!/bin/bash
# start-pokernow.sh — Start pokernow bridge (:3456) + orchestrator
# Usage: bash start-pokernow.sh --url "<pokernow-game-url>" --name <UserName>
# Only starts pokernow infrastructure. For full game (+ bots + BotManager), use project root start-game.sh.
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
[ -f "$PROJECT_ROOT/paths.env" ] && source "$PROJECT_ROOT/paths.env"
NODE="${NODE:-node}"
log() { echo "[pokernow-runtime] $*"; }

# ── Parse args ──
GAME_URL="" ; NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)  GAME_URL="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    *)      shift ;;
  esac
done
[ -z "$GAME_URL" ] && { log "ERROR: --url required (pokernow.com game URL)"; exit 1; }
[ -z "$NAME" ] && { log "ERROR: --name required (player name)"; exit 1; }

# ── 0. Stop old instances ──
bash "$SKILL_DIR/stop-pokernow.sh"
sleep 1

# ── 1. Install deps if missing ──
if [ ! -d "$SKILL_DIR/node_modules" ]; then
  log "Installing dependencies..."
  npm install --prefix "$SKILL_DIR" || { log "ERROR: npm install failed"; exit 1; }
fi

# ── 2. Start bridge (coach-ws.js → :3456) ──
BRIDGE_PID=$("$NODE" "$PROJECT_ROOT/scripts/detached-spawn.js" \
  --cwd "$PROJECT_ROOT" \
  --stdout /dev/null \
  --stderr /dev/null \
  -- "$NODE" "$SKILL_DIR/scripts/coach-ws.js" "$GAME_URL" --name "$NAME" --port 3456)
for i in $(seq 1 10); do
  curl -s --max-time 1 http://localhost:3456/state >/dev/null 2>&1 && break
  [ "$i" -eq 10 ] && { log "ERROR: bridge failed to start"; exit 1; }
  sleep 1
done
log "Bridge started on :3456 (player: $NAME)"

# ── 3. Start orchestrator ──
ORCHESTRATOR_PID=$("$NODE" "$PROJECT_ROOT/scripts/detached-spawn.js" \
  --cwd "$PROJECT_ROOT" \
  --stdout /dev/null \
  --stderr /dev/null \
  -- "$NODE" "$SKILL_DIR/scripts/orchestrator.js")
echo "$ORCHESTRATOR_PID" > "$SKILL_DIR/orchestrator.pid"
log "Orchestrator started (PID $ORCHESTRATOR_PID)"

log "Ready! Bridge :3456 + Orchestrator"
