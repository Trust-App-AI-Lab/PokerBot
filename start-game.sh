#!/bin/bash
# start-game.sh — Orchestrated startup: server + relay + bots + BotManager
# Usage: bash start-game.sh --name Enyan [--bots "Alice,Bob"] [--no-botmanager] [--public]
# Delegates to skill-level scripts, then handles bot join + BotManager on top.
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
log() { echo "[Game] $*"; }

# ── Parse args ──
NAME="" ; BOTS="" ; START_BM=true ; PUBLIC=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)          NAME="$2"; shift 2 ;;
    --bots)          BOTS="$2"; shift 2 ;;
    --no-botmanager) START_BM=false; shift ;;
    --public)        PUBLIC="--public"; shift ;;
    *)               shift ;;
  esac
done
[ -z "$NAME" ] && { log "ERROR: --name required"; exit 1; }

# ── 0. Full cleanup ──
log "Stopping old processes..."
bash "$PROJECT_ROOT/stop-game.sh"
sleep 1

# ── 1. Start server + relay (delegates to /poker-server) ──
PUBLIC_FLAG=""
[ -n "$PUBLIC" ] && PUBLIC_FLAG="--public"
bash "$PROJECT_ROOT/.claude/skills/poker-server/start-server.sh" --name "$NAME" $PUBLIC_FLAG
if [ $? -ne 0 ]; then
  log "ERROR: server startup failed"
  exit 1
fi

# ── 2. Discover + join bots ──
if [ -n "$BOTS" ]; then
  IFS=',' read -ra BOT_LIST <<< "$BOTS"
else
  BOT_LIST=()
  for dir in "$PROJECT_ROOT"/.claude/skills/bot-management/bots/*/; do
    bname=$(basename "$dir")
    [ "$bname" = ".template" ] && continue
    [ -f "$dir/personality.md" ] && BOT_LIST+=("$bname")
  done
fi

for bot in "${BOT_LIST[@]}"; do
  r=$(curl -s -X POST localhost:3457/join -H "Content-Type: application/json" -d "{\"name\":\"$bot\"}" 2>/dev/null)
  echo "$r" | grep -q '"ok"' && log "+ $bot" || log "~ $bot already in"
done

# ── 3. Start BotManager (delegates to /bot-management) ──
if $START_BM && [ ${#BOT_LIST[@]} -gt 0 ]; then
  bash "$PROJECT_ROOT/.claude/skills/bot-management/botmanager.sh" --server http://localhost:3457 > /dev/null 2>&1 &
  sleep 1
  log "BotManager started (PID $(cat "$PROJECT_ROOT/.claude/skills/bot-management/.botmanager.pid" 2>/dev/null))"
fi

log "Ready!"
