#!/bin/bash
# start-game.sh — PokerBot launcher (full stack, one command).
#
# Launches: server(:3457) + relay(:3456) + narrator(:3460)
#           + bots + BotManager + CoachBot pre-warm + opens browser.
#
# The server boots with phase=waiting — host clicks Start in the browser
# (or runs `curl -X POST :3457/start`) to deal the first hand.
#
# Usage:
#   bash .claude/skills/game/start-game.sh [flags]           # default: start
#   bash .claude/skills/game/start-game.sh stop              # kill everything
#   bash .claude/skills/game/start-game.sh restart [flags]   # stop then start
#
# Flags:
#   --name <Name>       your in-game name (default: $USER)
#   --bots "A,B"        comma-separated bot names (default: all non-template bots)
#   --auto              narrator starts in auto-play mode (CoachBot decides for you)
#   --lang zh|en        narrator language (default: zh)
#   --public            expose server on 0.0.0.0 for LAN play
#   --no-open           skip auto-opening the browser
#   --no-botmanager     human-only table, no bot decisions
#   --no-coach          skip CoachBot pre-warm (bot-vs-bot testing only)

set -e
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
log() { echo "[Game] $*"; }

# Source pinned binary paths if present (PY / NODE / CLAUDE_BIN)
[ -f "$PROJECT_ROOT/paths.env" ] && source "$PROJECT_ROOT/paths.env"
NODE="${NODE:-node}"

# ── Subcommand dispatch ──
CMD="start"
case "${1:-}" in
  stop)    CMD="stop";    shift ;;
  restart) CMD="restart"; shift ;;
  start)   CMD="start";   shift ;;
esac

# ── Defaults ──
NAME="${USER:-}"
BOTS=""
AUTO=false
LANG_TAG="zh"
PUBLIC=""
OPEN_BROWSER=true
START_BM=true
START_COACH=true

# ── Parse args ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)          NAME="$2"; shift 2 ;;
    --bots)          BOTS="$2"; shift 2 ;;
    --auto)          AUTO=true; shift ;;
    --lang)          LANG_TAG="$2"; shift 2 ;;
    --public)        PUBLIC="--public"; shift ;;
    --no-open)       OPEN_BROWSER=false; shift ;;
    --no-botmanager) START_BM=false; shift ;;
    --no-coach)      START_COACH=false; shift ;;
    -h|--help)       sed -n '3,22p' "$0"; exit 0 ;;
    *)               shift ;;
  esac
done

stop_all() {
  log "Stopping all PokerBot processes..."
  bash "$SKILL_DIR/stop-game.sh" 2>/dev/null || true
  log "Stopped."
}

if [ "$CMD" = "stop" ]; then
  stop_all
  exit 0
fi

if [ "$CMD" = "restart" ]; then
  stop_all
  sleep 1
fi

[ -z "$NAME" ] && { log "ERROR: --name required"; exit 1; }

# ── Helpers: deterministic SID + session wipe (fresh session per game) ──
_md5_hex() {
  # IMPORTANT: use `echo -n` to avoid trailing newline — the relay (Node,
  # poker-client.js) and BotManager hash the raw string with no newline.
  # A plain `echo` adds "\n" and produces a different SID, silently
  # wasting the pre-warm because the relay can't find the session.
  if command -v md5sum &>/dev/null; then printf %s "$1" | md5sum | awk '{print $1}'
  else printf %s "$1" | md5
  fi
}
_uuid_from() {
  _md5_hex "$1" | sed 's/\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\).*/\1-\2-\3-\4-\5/'
}
_project_enc() { echo "$PROJECT_ROOT" | sed 's|/|-|g'; }
wipe_session() {
  local sid="$1"
  local dir="$HOME/.claude/projects/$(_project_enc)"
  rm -f "$dir/$sid.jsonl"
  rm -rf "$dir/$sid"
}

# ── 0. Full cleanup ──
log "Stopping old processes..."
bash "$SKILL_DIR/stop-game.sh"
sleep 1

# ── 1. Write user name file + start server (delegates to poker-server) ──
# Relay reads game-data/.current-user when it launches, so write it first.
mkdir -p "$PROJECT_ROOT/game-data"
echo -n "$NAME" > "$PROJECT_ROOT/game-data/.current-user"

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

# ── 3. Wipe stale sessions (fresh session per game) ──
for bot in "${BOT_LIST[@]}"; do
  wipe_session "$(_uuid_from "pokerbot-$bot")"
done
COACH_SID=$(_uuid_from "coachbot-$NAME")
wipe_session "$COACH_SID"

# ── 4. CoachBot pre-warm (independent session, resumed per analysis) ──
if $START_COACH; then
  CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude)}"
  if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
    log "ERROR: claude CLI not found. Set CLAUDE_BIN in paths.env or install Claude Code."
    exit 1
  fi
  log "CoachBot pre-warming (session: $COACH_SID)..."
  COACH_INIT_PROMPT="Read .claude/skills/coachbot/SKILL.md and follow it throughout this session. Load /poker-strategy tier:pro (all 5 strategy docs) into context. When everything is loaded, reply exactly: load successfully"
  COACH_OUT=$("$CLAUDE_BIN" -p "$COACH_INIT_PROMPT" \
    --session-id "$COACH_SID" \
    --model opus \
    --permission-mode bypassPermissions 2>&1) || true
  if echo "$COACH_OUT" | grep -qi "load successfully"; then
    log "✓ CoachBot ready"
  else
    log "✗ CoachBot init failed — last output:"
    echo "$COACH_OUT" | tail -5 | sed 's/^/    /'
    log "  (game will continue without CoachBot pre-warm; relay will lazy-init on first ask)"
  fi
fi

# ── 5. Start BotManager ──
if $START_BM && [ ${#BOT_LIST[@]} -gt 0 ]; then
  bash "$PROJECT_ROOT/.claude/skills/bot-management/botmanager.sh" --server http://localhost:3457 > /dev/null 2>&1 &
  sleep 1
  log "BotManager started (PID $(cat "$PROJECT_ROOT/.claude/skills/bot-management/.botmanager.pid" 2>/dev/null))"
fi

# ── 6. Start relay (:3456) ──
RELAY_LOG="$PROJECT_ROOT/game-data/relay.log"
mkdir -p "$(dirname "$RELAY_LOG")"
log "Starting relay on :3456..."
POKER_USER="$NAME" "$NODE" "$PROJECT_ROOT/.claude/skills/poker-server/poker-client.js" \
  ws://localhost:3457 --name "$NAME" --port 3456 \
  > "$RELAY_LOG" 2>&1 &
RELAY_PID=$!
echo "$RELAY_PID" > "$PROJECT_ROOT/.claude/skills/poker-server/.relay.pid"
for i in $(seq 1 10); do
  curl -s --max-time 1 http://localhost:3456/state >/dev/null 2>&1 && { log "Relay up (PID $RELAY_PID, log: $RELAY_LOG)"; break; }
  [ "$i" -eq 10 ] && { log "ERROR: relay failed to start — see $RELAY_LOG"; exit 1; }
  sleep 1
done

# ── 7. Start narrator (:3460) ──
NARRATOR_LOG="$PROJECT_ROOT/game-data/narrator.log"
NARRATOR_ARGS=( --relay http://localhost:3456 --port 3460 --lang "$LANG_TAG" )
$AUTO && NARRATOR_ARGS+=( --auto )
log "Starting narrator on :3460 (mode=$($AUTO && echo auto || echo manual), lang=$LANG_TAG)..."
"$NODE" "$PROJECT_ROOT/.claude/skills/poker-server/narrator.js" "${NARRATOR_ARGS[@]}" \
  > "$NARRATOR_LOG" 2>&1 &
NARRATOR_PID=$!
echo "$NARRATOR_PID" > "$PROJECT_ROOT/.claude/skills/poker-server/.narrator.pid"
for i in $(seq 1 10); do
  curl -s --max-time 1 http://localhost:3460/mode >/dev/null 2>&1 && { log "Narrator up (PID $NARRATOR_PID, log: $NARRATOR_LOG)"; break; }
  [ "$i" -eq 10 ] && { log "WARN: narrator didn't respond on :3460 — see $NARRATOR_LOG"; }
  sleep 1
done

# ── 8. Open browser ──
if $OPEN_BROWSER; then
  URL="http://localhost:3456"
  if command -v open &>/dev/null; then
    open "$URL" 2>/dev/null || true
  elif command -v xdg-open &>/dev/null; then
    xdg-open "$URL" 2>/dev/null || true
  fi
  log "Browser → $URL"
fi

log "Ready! (CoachBot session: $COACH_SID)"

# ── Summary ──
cat <<EOF
[PokerBot] ────────────────────────────────────────
  name:     $NAME
  server:   http://localhost:3457
  relay:    http://localhost:3456   ← open this (host: click Start to deal)
  narrator: http://localhost:3460   (mode=$($AUTO && echo auto || echo manual))

  Deal the first hand (or click Start in the browser):
    curl -s -X POST localhost:3457/start -H "Content-Type: application/json" -d '{}'

  Switch narrator mode:
    curl -s -X POST localhost:3460/mode -H "Content-Type: application/json" -d '{"mode":"auto"}'
    curl -s -X POST localhost:3460/mode -H "Content-Type: application/json" -d '{"mode":"manual"}'

  Stop everything:
    bash .claude/skills/game/start-game.sh stop
────────────────────────────────────────────────────
EOF
