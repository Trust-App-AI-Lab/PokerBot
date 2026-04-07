# Coach Bridge — Connection & API Reference

CoachBot's connection infrastructure. Handles browser bridge injection, HTTP server, and the `__coach` API.
CoachBot runs in the **main CC session** (not in orchestrator, not in BotManager), communicating through `coach-bridge.js` injected into the user's PokerNow browser tab.

## Architecture

```
coach-bridge.js (browser)  ──push──▶  coach-server.js (localhost:3456)  ──write──▶  state.json
                           ◀─poll──                                     ◀─curl───  CC (Read/Bash)
                            /action                                      POST /action
```

- **State reading**: CC reads `bot_profiles/CoachBot/state.json` via Read tool (instant, no javascript_tool)
- **Action sending**: CC sends `curl POST localhost:3456/action` (bridge polls every 1s, executes via DOM)
- **History**: `bot_profiles/CoachBot/history.jsonl` — appended on each turn/event
- **javascript_tool**: only needed ONCE at game start to inject bridge. After that, all communication is HTTP.

## Setup Flow

CoachBot activation is **automatic on Enter Room** (see `SKILL.md` → Enter Room → CoachBot Activation).

1. CC loads this file (`COACH-BRIDGE.md`) — for API reference, endpoints, action format
2. CC triggers **CoachBot Activation** (see `CLAUDE.md`) — loads personality.md + poker-agent/SKILL.md + 5 strategy files (once per session; authoritative file list is in `CLAUDE.md`)
3. CC injects `coach-bridge.js` via `javascript_tool(tabId, bridgeCode)` — **one time only**
4. CC starts coach-server: `node pokernow-bot/scripts/coach-server.js "gameUrl"` (auto-kills old instance)
5. Bridge hooks page WebSocket, starts pushing state to server, starts polling `/action`
6. From here on, CC uses only `Read` + `curl` — no more javascript_tool needed

## Reading State

```python
# Read preprocessed compact state (instant)
Read("bot_profiles/CoachBot/state.json")
```

State is preprocessed by coach-server: player IDs → names, empty fields stripped, ~28 lines.

## Executing Actions

```bash
# Send action via HTTP (bridge picks up within 1s)
curl -s -X POST localhost:3456/action -H "Content-Type: application/json" -d '{"action":"call"}'
curl -s -X POST localhost:3456/action -H "Content-Type: application/json" -d '{"action":"raise","amount":200}'
curl -s -X POST localhost:3456/action -H "Content-Type: application/json" -d '{"action":"fold"}'

# Check result
curl -s localhost:3456/action-result
```

Valid actions: `fold`, `check`, `call`, `raise` (with amount), `allin`

## `__coach` API Reference

### Read State (legacy — use Read tool instead)
```js
__coach.getState()        // Clean state copy
__coach.state             // Live reference
__coach.getPlayerId()     // Current player ID
__coach.isConnected()     // Is hooked WS still open?
__coach.getLogs()         // Last 50 debug log entries
```

### Execute Actions (legacy — use curl instead)
```js
__coach.act('fold')
__coach.act('check')
__coach.act('call')
__coach.act('raise 300')
__coach.act('allin')
```

### Host Commands via WebSocket
```js
__coach.host('pause')                          // Pause game
__coach.host('resume')                         // Resume game
__coach.host('stop')                           // Request stop game
__coach.host('cancelstop')                     // Cancel stop request
```

### Host Actions via HTTP (Path A only — user is host)
```js
__coach.hostAction('start-game', {})
__coach.hostAction('approve_player', { playerID: 'xxx', stackChange: 1000 })
__coach.hostAction('remove_player', { playerID: 'xxx' })
```

### Fetch Game Log
```js
__coach.fetchLog()
// Returns: Promise<{ nameMap: {playerId: name}, logCount: number }>
```

### Polling
```js
__coach.startPolling()    // Beep sound when it's user's turn
__coach.stopPolling()     // Stop polling + reset tab title
```

## coach-server.js Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /health | Server status (pid, uptime, name count) |
| GET | /action | Bridge polls for pending action |
| GET | /action-result | CC checks action execution result |
| POST | /state | Bridge pushes state → preprocessed → state.json |
| POST | /event | Bridge pushes event → history.jsonl |
| POST | /turn | Bridge pushes turn state → state.json + history.jsonl |
| POST | /action | CC sends action for bridge to execute |
| POST | /action-result | Bridge reports action result |
| POST | /config | Set gameUrl, nameMap |

Start: `node pokernow-bot/scripts/coach-server.js [gameUrl]` (auto-kills old instance via PID file)

## autoAdvice Toggle

Controlled by `autoAdvice` field in game.json (default: `false`).

- **false** (default): CC only reads state and gives advice when user asks
- **true**: CC checks state on each user message, auto-shows GTO advice when `isMyTurn`

Toggle: "别给我建议了" → off, "帮我盯着" → on
