#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

exec bash .agents/skills/game/start-game.sh "$@"
