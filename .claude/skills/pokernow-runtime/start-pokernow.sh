#!/bin/bash
# start-pokernow.sh — Start pokernow bridge (:3456) + orchestrator
# Usage: bash start-pokernow.sh --url "<pokernow-game-url>" --name <UserName>
# Only starts pokernow infrastructure. For full game (+ bots + BotManager), use project root start-game.sh.
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
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
node "$SKILL_DIR/scripts/coach-ws.js" "$GAME_URL" --name "$NAME" --port 3456 > /dev/null 2>&1 &
for i in $(seq 1 10); do
  curl -s --max-time 1 http://localhost:3456/state >/dev/null 2>&1 && break
  [ "$i" -eq 10 ] && { log "ERROR: bridge failed to start"; exit 1; }
  sleep 1
done
log "Bridge started on :3456 (player: $NAME)"

# ── 3. Start orchestrator ──
node "$SKILL_DIR/scripts/orchestrator.js" > /dev/null 2>&1 &
echo $! > "$SKILL_DIR/orchestrator.pid"
log "Orchestrator started (PID $!)"

log "Ready! Bridge :3456 + Orchestrator"
