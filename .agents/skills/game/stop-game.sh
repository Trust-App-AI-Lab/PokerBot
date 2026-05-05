#!/bin/bash
# stop-game.sh — Full shutdown: BotManager + pokernow + server + relay.
# Also wipes mapped Codex logical sessions so the NEXT `start-game.sh`
# runs against a truly empty slate.
# Delegates to skill-level stop scripts for process kills; session wipe is
# done inline here since it's cross-skill cleanup.
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
log() { echo "[StopGame] $*"; }

# Source pinned binary paths if present (PY / NODE / CODEX_BIN)
[ -f "$PROJECT_ROOT/paths.env" ] && source "$PROJECT_ROOT/paths.env"
NODE="${NODE:-node}"
CODEX_AGENT="$PROJECT_ROOT/scripts/codex-agent.js"
wipe_session() {
  local session_key="$1"
  "$NODE" "$CODEX_AGENT" --reset --session-key "$session_key" >/dev/null 2>&1 || true
}

# 1. Stop BotManager (delegates to /bot-management)
bash "$PROJECT_ROOT/.agents/skills/bot-management/stop-botmanager.sh"

# 2. Stop narrator + relay + server (delegates to poker-server)
bash "$PROJECT_ROOT/.agents/skills/poker-server/stop-server.sh"

# 3. Stop pokernow fallback infrastructure (may not be running)
bash "$PROJECT_ROOT/.agents/skills/pokernow-runtime/stop-pokernow.sh"

# 4. Wipe bot sessions (every bot under bot-management/bots/) + CoachBot.
#    We only know the CoachBot SID if .current-user is present — it's written
#    by start-game.sh so it'll be there unless someone nuked game-data/.
wiped=0
for dir in "$PROJECT_ROOT"/.agents/skills/bot-management/bots/*/; do
  bname=$(basename "$dir")
  [ "$bname" = ".template" ] && continue
  [ -f "$dir/personality.md" ] || continue
  wipe_session "pokerbot-$bname"
  wiped=$((wiped + 1))
done
if [ -f "$PROJECT_ROOT/game-data/.current-user" ]; then
  NAME=$(cat "$PROJECT_ROOT/game-data/.current-user" 2>/dev/null)
  if [ -n "$NAME" ]; then
    wipe_session "coachbot-$NAME"
    wiped=$((wiped + 1))
    # Also wipe this user's profile: chat/hand history jsonls + live state.
    # UI doesn't read these directly for display (chat is in browser
    # localStorage — see gameId auto-clear in poker-table.html), but they're
    # residue from the prior game and shouldn't leak into the next one's
    # history review features.
    PROFILE="$PROJECT_ROOT/game-data/$NAME"
    if [ -d "$PROFILE" ]; then
      rm -f "$PROFILE/history/"*.jsonl 2>/dev/null
      rm -f "$PROFILE/state.json" 2>/dev/null
      log "Wiped profile $NAME (history + state.json)."
    fi
  fi
fi
log "Wiped $wiped Codex logical session(s)."

log "All stopped."
