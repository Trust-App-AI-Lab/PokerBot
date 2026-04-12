#!/bin/bash
# start-server.sh — Start poker-server (:3457) + relay (:3456)
# Usage: bash start-server.sh --name <PlayerName> [--public]
# Only starts server infrastructure. For full game (+ bots + BotManager), use project root start-game.sh.
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
log() { echo "[poker-server] $*"; }

# ── Parse args ──
NAME="" ; PUBLIC=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)   NAME="$2"; shift 2 ;;
    --public) PUBLIC="--public"; shift ;;
    *)        shift ;;
  esac
done
[ -z "$NAME" ] && { log "ERROR: --name required"; exit 1; }

# ── 0. Stop old instances ──
bash "$SKILL_DIR/stop-server.sh"
sleep 1

# ── 0.5. Auto-install dependencies ──
if [ ! -d "$SKILL_DIR/node_modules" ]; then
  log "Installing dependencies..."
  npm install --prefix "$SKILL_DIR" || { log "ERROR: npm install failed"; exit 1; }
fi

# ── 1. Server on :3457 ──
node "$SKILL_DIR/poker-server.js" $PUBLIC > /dev/null 2>&1 &
for i in $(seq 1 8); do
  curl -s --max-time 1 http://localhost:3457/info >/dev/null 2>&1 && break
  [ "$i" -eq 8 ] && { log "ERROR: server failed to start"; exit 1; }
  sleep 1
done
log "Server started on :3457"

# ── 2. Relay on :3456 ──
node "$SKILL_DIR/poker-client.js" ws://localhost:3457 --name "$NAME" --port 3456 > /dev/null 2>&1 &
for i in $(seq 1 10); do
  curl -s --max-time 1 http://localhost:3456/state >/dev/null 2>&1 && break
  [ "$i" -eq 10 ] && { log "ERROR: relay failed to start"; exit 1; }
  sleep 1
done
log "Relay started on :3456 (player: $NAME)"

log "Ready! Server :3457 + Relay :3456"
