# PokerNow Runtime Architecture

This folder is the fallback adapter for external PokerNow rooms. The main
self-hosted PokerBot flow does not use it.

## Components

- `lib/poker-now.js`: WebSocket client for PokerNow.
- `lib/game-state.js`: normalizes room events into agent-readable state.
- `scripts/bridge-live.js`: long-running bridge that writes `turn.json` and
  reads `action.json`.
- `scripts/coach-ws.js`: optional local coach WebSocket bridge.
- `scripts/orchestrator.js`: legacy orchestrator for file-mode runs.

## File IPC

- `turn.json`: written when the bot needs an action.
- `action.json`: read by the bridge after the agent writes a decision.
- `state.json`: current normalized state snapshot.
- `history.jsonl`: append-only hand/event history.

## Codex Boundary

The fallback is intentionally file-oriented: PokerNow stays isolated from the
Codex runtime. The agent reads `turn.json`, writes `action.json`, and the bridge
executes that action in the room.
