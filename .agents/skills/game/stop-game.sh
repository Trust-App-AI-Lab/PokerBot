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
resolve_codex_agent() {
  local candidates=(
    "${STUCLAW_CODEX_AGENT:-}"
    "${STUCLAW_DESKTOP_ROOT:+$STUCLAW_DESKTOP_ROOT/scripts/codex-agent.cjs}"
    "$PROJECT_ROOT/../stuclaw-desktop/scripts/codex-agent.cjs"
    "$PROJECT_ROOT/../../scripts/codex-agent.cjs"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    [ -n "$candidate" ] && [ -f "$candidate" ] && { echo "$candidate"; return; }
  done
}
CODEX_AGENT="$(resolve_codex_agent)"
wipe_session() {
  local session_key="$1"
  [ -n "$CODEX_AGENT" ] || return 0
  "$NODE" "$CODEX_AGENT" --app-dir "$PROJECT_ROOT" --reset --session-key "$session_key" >/dev/null 2>&1 || true
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
    # Also wipe this user's profile: CoachBot chat, hand history, and live
    # state. The browser hydrates from coach-chat.jsonl and keeps a bounded
    # localStorage cache, so both server data and the next game id must reset.
    PROFILE="$PROJECT_ROOT/game-data/$NAME"
    if [ -d "$PROFILE" ]; then
      rm -f "$PROFILE/history/"*.jsonl 2>/dev/null
      rm -f "$PROFILE/coach-chat.jsonl" 2>/dev/null
      rm -f "$PROFILE/state.json" 2>/dev/null
      log "Wiped profile $NAME (coach chat + history + state.json)."
    fi
  fi
fi
rm -f "$PROJECT_ROOT/game-data/.current-game-id" 2>/dev/null
log "Wiped $wiped Codex logical session(s)."

log "All stopped."
