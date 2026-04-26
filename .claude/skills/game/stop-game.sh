#!/bin/bash
# stop-game.sh — Full shutdown: BotManager + pokernow + server + relay.
# Also wipes bot + CoachBot claude session files so the NEXT `start-game.sh`
# runs against a truly empty slate — no --resume fallback into a stale
# previous game's transcript.
# Delegates to skill-level stop scripts for process kills; session wipe is
# done inline here since it's cross-skill cleanup.
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
log() { echo "[StopGame] $*"; }

# ── md5 / session-path helpers (mirror start-game.sh) ──
_md5_hex() {
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

# 1. Stop BotManager (delegates to /bot-management)
bash "$PROJECT_ROOT/.claude/skills/bot-management/stop-botmanager.sh"

# 2. Stop pokernow (delegates to pokernow-runtime — may not be running)
bash "$PROJECT_ROOT/.claude/skills/pokernow-runtime/stop-pokernow.sh"

# 3. Stop narrator + relay + server (delegates to poker-server)
bash "$PROJECT_ROOT/.claude/skills/poker-server/stop-server.sh"

# 4. Wipe bot sessions (every bot under bot-management/bots/) + CoachBot.
#    We only know the CoachBot SID if .current-user is present — it's written
#    by start-game.sh so it'll be there unless someone nuked game-data/.
wiped=0
for dir in "$PROJECT_ROOT"/.claude/skills/bot-management/bots/*/; do
  bname=$(basename "$dir")
  [ "$bname" = ".template" ] && continue
  [ -f "$dir/personality.md" ] || continue
  wipe_session "$(_uuid_from "pokerbot-$bname")"
  wiped=$((wiped + 1))
done
if [ -f "$PROJECT_ROOT/game-data/.current-user" ]; then
  NAME=$(cat "$PROJECT_ROOT/game-data/.current-user" 2>/dev/null)
  if [ -n "$NAME" ]; then
    wipe_session "$(_uuid_from "coachbot-$NAME")"
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
log "Wiped $wiped claude session(s)."

log "All stopped."
