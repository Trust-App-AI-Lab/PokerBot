# Poker Server Architecture

This folder owns PokerBot's local self-hosted table.

## Processes

- `poker-server.js`: authoritative game engine and WebSocket server on `:3457`.
- `poker-client.js`: local relay and browser UI server on `:3456`.
- `narrator.js`: event-driven CoachBot trigger on `:3460`.

## Ports

- `:3457`: host/server API. BotManager uses this for isolated bot state and direct bot actions.
- `:3456`: player-facing relay. Browser UI, CoachBot panel, `/state`, `/action`, `/coach-ask`.
- `:3460`: narrator mode/status API.

## Runtime Files

- PID files live in this folder: `.server.pid`, `.relay.pid`, `.narrator.pid`.
- Long-lived logs and per-player state live in project-root `game-data/`.

## Session Boundary

The server never talks to Codex directly. Bot and CoachBot turns go through
StuClaw Desktop's `scripts/codex-agent.cjs`, which maps stable logical keys to
Codex thread ids in `.stuclaw/sessions.json`.
