#!/bin/bash
# stop-game.sh — Full shutdown: BotManager + pokernow + server + relay
# Delegates to skill-level stop scripts. One command, all modes.
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
log() { echo "[StopGame] $*"; }

# 1. Stop BotManager (delegates to /bot-management)
bash "$PROJECT_ROOT/.claude/skills/bot-management/stop-botmanager.sh"

# 2. Stop pokernow (delegates to /pokernow-runtime — may not be running)
bash "$PROJECT_ROOT/.claude/skills/pokernow-runtime/stop-pokernow.sh"

# 3. Stop server + relay (delegates to /poker-server)
bash "$PROJECT_ROOT/.claude/skills/poker-server/stop-server.sh"

log "All stopped."
