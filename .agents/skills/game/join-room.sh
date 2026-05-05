#!/bin/bash
# join-room.sh - Join a friend's PokerBot server without blocking Codex.
#
# Starts only the local relay (:3456 by default) as a detached background
# process. It does not start a local poker-server.

set -e

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
log() { echo "[JoinRoom] $*"; }

[ -f "$PROJECT_ROOT/paths.env" ] && source "$PROJECT_ROOT/paths.env"
NODE="${NODE:-node}"

NAME="${USER:-Player}"
ROOM_URL=""
PORT=3456
OPEN_BROWSER=true

usage() {
  cat <<'EOF'
Usage: bash .agents/skills/game/join-room.sh --url <friend-url> [--name <Name>] [--port 3456] [--no-open]

Examples:
  bash .agents/skills/game/join-room.sh --url ws://192.168.1.5:3457 --name Enyan --no-open
  bash .agents/skills/game/join-room.sh --url http://192.168.1.5:3456 --name Enyan
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url|--room|--server) ROOM_URL="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --no-open) OPEN_BROWSER=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) shift ;;
  esac
done

[ -z "$ROOM_URL" ] && { usage; exit 2; }
[ -z "$NAME" ] && { log "ERROR: --name required"; exit 2; }

WS_URL=$("$NODE" - "$ROOM_URL" <<'JS'
const rawInput = process.argv[2] || '';
let raw = rawInput.trim();
if (!raw) process.exit(2);

const hadScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw);
if (!hadScheme) raw = `ws://${raw}`;

const url = new URL(raw);
if (url.protocol === 'http:') url.protocol = 'ws:';
else if (url.protocol === 'https:') url.protocol = 'wss:';
else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
  throw new Error(`Unsupported room URL protocol: ${url.protocol}`);
}

const privateHost =
  url.hostname === 'localhost' ||
  url.hostname === '127.0.0.1' ||
  /^10\./.test(url.hostname) ||
  /^192\.168\./.test(url.hostname) ||
  /^172\.(1[6-9]|2\d|3[0-1])\./.test(url.hostname);

if (url.port === '3456') url.port = '3457';
if (!url.port && (!hadScheme || privateHost)) url.port = '3457';

url.pathname = '/';
url.search = '';
url.hash = '';
console.log(url.toString().replace(/\/$/, ''));
JS
)

mkdir -p "$PROJECT_ROOT/game-data"
echo -n "$NAME" > "$PROJECT_ROOT/game-data/.current-user"

kill_port() {
  local port="$1"
  local pid
  pid=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)
  if [ -n "$pid" ]; then
    kill -9 "$pid" 2>/dev/null || true
    log "Stopped old local process on :$port (PID $pid)"
  fi
}

kill_port "$PORT"
kill_port 3460
bash "$PROJECT_ROOT/.agents/skills/bot-management/stop-botmanager.sh" >/dev/null 2>&1 || true
rm -f "$PROJECT_ROOT/.agents/skills/poker-server/.relay.pid"
rm -f "$PROJECT_ROOT/.agents/skills/poker-server/.narrator.pid"

RELAY_LOG="$PROJECT_ROOT/game-data/relay.log"
: > "$RELAY_LOG"
log "Starting local relay on :$PORT -> $WS_URL"
RELAY_PID=$("$NODE" "$PROJECT_ROOT/scripts/detached-spawn.js" \
  --cwd "$PROJECT_ROOT" \
  --stdout "$RELAY_LOG" \
  --stderr "$RELAY_LOG" \
  --env "POKER_USER=$NAME" \
  -- "$NODE" "$PROJECT_ROOT/.agents/skills/poker-server/poker-client.js" "$WS_URL" --name "$NAME" --port "$PORT")
echo "$RELAY_PID" > "$PROJECT_ROOT/.agents/skills/poker-server/.relay.pid"

READY=false
for _ in $(seq 1 10); do
  if curl -s --max-time 1 "http://localhost:$PORT/state" >/dev/null 2>&1 \
      && grep -q "Joined as " "$RELAY_LOG" 2>/dev/null; then
    READY=true
    break
  fi
  sleep 1
done

if [ "$READY" != "true" ]; then
  log "ERROR: relay failed to become ready - see $RELAY_LOG"
  tail -20 "$RELAY_LOG" 2>/dev/null || true
  exit 1
fi

URL="http://localhost:$PORT"
if $OPEN_BROWSER; then
  if command -v open >/dev/null 2>&1; then
    open "$URL" 2>/dev/null || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" 2>/dev/null || true
  fi
fi

log "Ready: $URL (PID $RELAY_PID, log: $RELAY_LOG)"
