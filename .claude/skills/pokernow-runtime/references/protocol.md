# Poker Now Protocol — Detailed Reference

For quick reference, see the table in SKILL.md. This file has the full details.

## Engine.IO v3 Packet Types

| Code | Name | Direction | Description |
|------|------|-----------|-------------|
| 0 | open | S→C | Handshake: `0{"sid":"xxx","upgrades":[],"pingInterval":20000,"pingTimeout":25000}` |
| 1 | close | Both | Connection close |
| 2 | ping | C→S | Client heartbeat (send every `pingInterval` ms) |
| 3 | pong | S→C | Server pong response |
| 4 | message | Both | Socket.IO packet container |
| 5 | upgrade | — | Not used (no transport upgrade) |
| 6 | noop | — | Not used |

## Socket.IO Packet Types (inside EIO message "4")

| Code | Wire | Name | Description |
|------|------|------|-------------|
| 0 | 40 | CONNECT | Namespace connection confirmed |
| 1 | 41 | DISCONNECT | — |
| 2 | 42 | EVENT | `42["eventName", payload]` — all game events |
| 3 | 43 | ACK | Acknowledgement with callback ID |
| 4 | 44 | ERROR | — |

## Game Events

| Event | When | Payload |
|-------|------|---------|
| `registered` | Once on connect | `{currentPlayer: {id}, gameState: {full frame}}` |
| `change` | Every state update | Partial frame (merge into stored state) |
| `gC` | Periodic | Game clock sync (not critical) |
| `rup` | Between hands | Round update / new hand prompt |
| `nEM` | Various | New event message (chat, system) |
| `rEM` | Various | Remove event message |
| `GAME:TO_CLIENT` | Various | Game-level notifications |
| `failed` | After invalid action | Action failure details |

## Frame Fields

### Game
| Field | Type | Notes |
|-------|------|-------|
| `status` | str | `"waiting"`, `"inGame"`, `"starting"` |
| `pot` | int | Current pot |
| `bigBlind` | int | Big blind amount |
| `smallBlind` | int | Small blind amount |
| `dealerSeat` | int | Dealer button seat number |
| `gM` | str | Game mode, `"th"` = Texas Hold'em |

### Players
`players` is a dict keyed by player ID.

| Field | Type | Notes |
|-------|------|-------|
| `name` | str | Display name |
| `stack` | int | Chip count |
| `currentBet` | int | Bet in current round |
| `status` | str | `"watching"`, `"inGame"`, `"requestedGameIngress"` |
| `gameStatus` | str | `"inGame"`, `"fold"`, `"check"`, `"allIn"` |
| `actionStartedAt` | int/null | Timestamp when turn started (non-null = their turn) |
| `usingTimeBank` | bool | Using time bank extension |
| `winCount` | int | Hands won |

### Seats
`seats` is an array of `[seatNumber, playerId]` pairs.

### Cards (`pC`)
Dict with mixed keys:
- **Player ID keys** → array of `{value: "Ah"}` objects (hole cards). Opponents' value is `null` until showdown.
- **Numeric keys** (e.g., `"0"`, `"1"`) → array of card strings (community cards)

### Events Data (`eventsData`)
Array of action history entries. Can be strings like `"PlayerName raises to 100"` or structured objects with `{player, action, amount}`.

## Action Protocol

All actions sent via:
```
42["action", {"type": "updateIntendedAction", "kind": "<KIND>", ...}]
```

| Kind | Extra fields | Notes |
|------|-------------|-------|
| `PLAYER_FOLD` | — | |
| `PLAYER_CHECK` | — | |
| `PLAYER_CALL` | — | |
| `PLAYER_RAISE` | `"value": N` | N = total bet (not increment) |
| `CHECK_OR_FOLD` | — | Auto-action: check if possible, else fold |

Start next hand:
```
42["action", {"type": "NH", "socket": true}]
```

## Card Encoding

Format: `"{rank}{suit}"`

- Ranks: `2 3 4 5 6 7 8 9 T J Q K A`
- Suits: `d`=♦ `h`=♥ `c`=♣ `s`=♠

Examples: `Ah`=A♥, `Td`=10♦, `2c`=2♣, `Ks`=K♠
