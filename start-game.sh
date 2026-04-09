#!/bin/bash
# start-game.sh — Start server + join bots + BotManager
# Relay on :3456 is managed by CC (poker-client.js) — has auto-reconnect so order doesn't matter.
# Usage: bash start-game.sh --name Enyan [--bots "Alice,Bob"] [--no-botmanager]
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
log() { echo "[Game] $*"; }

# ── Parse args ──
NAME="" ; BOTS="" ; START_BM=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)          NAME="$2"; shift 2 ;;
    --bots)          BOTS="$2"; shift 2 ;;
    --no-botmanager) START_BM=false; shift ;;
    *)               shift ;;
  esac
done
[ -z "$NAME" ] && { log "ERROR: --name required"; exit 1; }

# ── 1. Server on :3457 ──
if curl -s --max-time 1 http://localhost:3457/info >/dev/null 2>&1; then
  log "Server already on :3457"
else
  node "$PROJECT_ROOT/poker-server/poker-server.js" > /dev/null 2>&1 &
  for i in $(seq 1 5); do
    curl -s --max-time 1 http://localhost:3457/info >/dev/null 2>&1 && break
    [ "$i" -eq 5 ] && { log "ERROR: server failed"; exit 1; }
    sleep 1
  done
  log "Server started on :3457"
fi

# ── 2. Wait for relay on :3456 (CC starts poker-client.js separately) ──
log "Waiting for relay on :3456..."
for i in $(seq 1 10); do
  curl -s --max-time 1 http://localhost:3456/state >/dev/null 2>&1 && { log "Relay ready"; break; }
  [ "$i" -eq 10 ] && log "WARN: relay not detected — CC should start poker-client.js first"
  sleep 1
done

# ── 3. Join bots ──
if [ -n "$BOTS" ]; then
  IFS=',' read -ra BOT_LIST <<< "$BOTS"
else
  BOT_LIST=()
  for dir in "$PROJECT_ROOT"/bot_profiles/*/; do
    bname=$(basename "$dir")
    [ -f "$dir/personality.md" ] && [ "$bname" != "CoachBot" ] && BOT_LIST+=("$bname")
  done
fi

for bot in "${BOT_LIST[@]}"; do
  r=$(curl -s -X POST localhost:3457/join -H "Content-Type: application/json" -d "{\"name\":\"$bot\"}" 2>/dev/null)
  echo "$r" | grep -q '"ok"' && log "+ $bot" || log "~ $bot already in"
done

# ── 4. BotManager ──
if $START_BM && [ ${#BOT_LIST[@]} -gt 0 ]; then
  bash "$PROJECT_ROOT/bot_profiles/botmanager.sh" --server http://localhost:3457 > /dev/null 2>&1 &
  sleep 1
  log "BotManager started (PID $(cat "$PROJECT_ROOT/bot_profiles/.botmanager.pid" 2>/dev/null))"
fi

log "Ready! Say '开�