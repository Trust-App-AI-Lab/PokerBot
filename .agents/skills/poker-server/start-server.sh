#!/bin/bash
# start-server.sh — Start poker-server (:3457) only.
# Usage: bash start-server.sh --name <PlayerName> [--public]
#
# The relay (:3456) and narrator (:3460) are launched by start-game.sh
# (one level up in /.agents/skills/game/) — this script only owns the
# engine. --name is required so start-game.sh can stamp
# game-data/.current-user (read by the relay when it launches).
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
[ -f "$PROJECT_ROOT/paths.env" ] && source "$PROJECT_ROOT/paths.env"
NODE="${NODE:-node}"
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
mkdir -p "$PROJECT_ROOT/game-data"
SERVER_LOG="$PROJECT_ROOT/game-data/server.log"
SERVER_PID=$("$NODE" "$PROJECT_ROOT/scripts/detached-spawn.js" \
  --cwd "$PROJECT_ROOT" \
  --stdout "$SERVER_LOG" \
  --stderr "$SERVER_LOG" \
  -- "$NODE" "$SKILL_DIR/poker-server.js" $PUBLIC)
echo "$SERVER_PID" > "$SKILL_DIR/.server.pid"
for i in $(seq 1 8); do
  curl -s --max-time 1 http://localhost:3457/info >/dev/null 2>&1 && break
  [ "$i" -eq 8 ] && { log "ERROR: server failed to start — see $SERVER_LOG"; exit 1; }
  sleep 1
done
log "Server started on :3457 (PID $SERVER_PID, log: $SERVER_LOG; relay/narrator launched by start-game.sh)"
