#!/usr/bin/env node
/**
 * poker-server.js — Self-Hosted Texas Hold'em Server
 *
 * Replaces pokernow.com entirely. Runs a full poker game that anyone can join
 * via browser (local or remote via ngrok/tunnel/public IP).
 *
 * Features:
 *   - Texas Hold'em engine (blinds, betting, side pots, showdown)
 *   - Browser UI (poker-table.html) served automatically
 *   - WebSocket real-time updates (no polling)
 *   - Players join by opening URL + entering a name
 *   - AI bots connect the same way (WebSocket client)
 *   - CC reads state.json for GTO coaching
 *
 * Usage:
 *   node poker-server.js                          # default :3457
 *   node poker-server.js --port 8080              # custom port
 *   node poker-server.js --blinds 10/20           # custom blinds
 *   node poker-server.js --stack 1000             # default buy-in
 *
 * Remote play:
 *   ngrok http 3457   →  share the https URL with friends
 */

const path = require('path');
const fs   = require('fs');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { PokerEngine } = require('./lib/poker-engine');

// ── Parse args ──────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const PORT = parseInt(getArg('port', '3457'));
let STACK = parseInt(getArg('stack', '1000'));
const blindsStr = getArg('blinds', '10/20');
let [SB, BB] = blindsStr.split('/').map(Number);
const PUBLIC = args.includes('--public');
const TUNNEL_SUBDOMAIN = getArg('subdomain', ''); // --subdomain mypoker → mypoker.loca.lt

// ── Paths ───────────────────────────────────────
const SERVER_DIR    = __dirname;
const PROJECT_ROOT  = path.join(SERVER_DIR, '..');
const TABLE_HTML    = path.join(SERVER_DIR, 'public', 'poker-table.html');
const BOT_PROFILES  = path.join(PROJECT_ROOT, 'bot_profiles');
const COACH_PROFILE = path.join(BOT_PROFILES, 'CoachBot');
const STATE_FILE    = path.join(COACH_PROFILE, 'state.json');

if (!fs.existsSync(COACH_PROFILE)) fs.mkdirSync(COACH_PROFILE, { recursive: true });

// ── Logger ──────────────────────────────────────
function ts() { return new Date().toISOString().replace('T',' ').substring(0,19); }
const log = {
  info:  (...a) => console.log(`[${ts()}]`, ...a),
  warn:  (...a) => console.log(`[${ts()}] WARN`, ...a),
  error: (...a) => console.error(`[${ts()}] ERR`, ...a),
};

// ══════════════════════════════════════════════════
// GAME ENGINE
// ══════════════════════════════════════════════════

const engine = new PokerEngine({
  smallBlind: SB,
  bigBlind:   BB,
  autoStart:  false,  // Wait for host to connect before starting
});

// ══════════════════════════════════════════════════
// CONNECTED CLIENTS
// ══════════════════════════════════════════════════
// Each WS connection → { ws, playerName, authenticated }

const clients = new Map(); // ws → { playerName, authenticated }

function broadcast(type, data, exceptWs) {
  const msg = JSON.stringify({ type, ...data });
  for (const [ws, client] of clients) {
    if (ws !== exceptWs && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function sendTo(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function sendStateToAll() {
  for (const [ws, client] of clients) {
    if (client.playerName && ws.readyState === WebSocket.OPEN) {
      const state = engine.getPlayerState(client.playerName);
      if (turnDeadline > 0) state.turnDeadline = turnDeadline;
      sendTo(ws, 'state', { state });
    }
  }
  // Also write state.json for CC
  writeCoachState();
}

function writeCoachState() {
  try {
    // Information-isolated: only CoachBot's own cards visible
    const state = engine.getPlayerState('CoachBot');
    state.timestamp = Date.now();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log.warn(`Failed to write CoachBot state: ${e.message}`);
  }
}

// ══════════════════════════════════════════════════
// ENGINE EVENT HANDLERS
// ══════════════════════════════════════════════════

// ── Hand History Recording (event-based, naturally crash-safe) ──
// Each event is appended as one JSON line to history.jsonl immediately.
// Event types: hand_start, action, board, hand_end
const HISTORY_FILE = path.join(__dirname, 'history.jsonl');
const ACT_NAME = { call:'call', check:'check', fold:'fold', bet:'bet', raise:'raise', small_blind:'sb', big_blind:'bb' };
let currentHandNumber = 0;

function logEvent(event) {
  const ordered = { ts: new Date().toISOString(), ...event };
  try { fs.appendFileSync(HISTORY_FILE, JSON.stringify(ordered) + '\n'); } catch (e) {
    log.warn(`Failed to write history: ${e.message}`);
  }
}

engine.on('hand_start', (data) => {
  log.info(`=== HAND #${data.handNumber} === Dealer: ${data.dealer}`);
  currentHandNumber = data.handNumber;
  // Build players map: { name: [cards, startingStack] }  — cards = full (server-side truth)
  const players = {};
  for (const name of engine.seatOrder) {
    const p = engine.players.get(name);
    if (p) players[name] = [[...p.cards], p.stack + p.bet];
  }
  logEvent({
    type: 'hand_start',
    hand: data.handNumber,
    blinds: [SB, BB],
    positions: data.positions,
    players,
  });
  sendStateToAll();
});

engine.on('cards_dealt', (data) => {
  // Send cards only to the player who owns them
  for (const [ws, client] of clients) {
    if (client.playerName === data.player) {
      sendTo(ws, 'cards', { cards: data.cards });
    }
  }
  sendStateToAll();
});

engine.on('blind_posted', (data) => {
  log.info(`  ${data.type}: ${data.player} $${data.amount}`);
  sendStateToAll();
});

// ── Turn timer ──
let TURN_TIMEOUT = 180000; // 3 minutes per action (mutable via /config)
let turnTimer = null;
let turnDeadline = 0;

function clearTurnTimer() {
  if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
  turnDeadline = 0;
}

function startTurnTimer(playerName) {
  clearTurnTimer();
  turnDeadline = Date.now() + TURN_TIMEOUT;
  const handNum = engine.handNumber;
  turnTimer = setTimeout(() => {
    turnTimer = null;
    turnDeadline = 0;
    if (engine.handNumber === handNum && engine.seatOrder[engine._currentPlayerIdx] === playerName) {
      log.warn(`⏱ Turn timeout: ${playerName} auto-fold/check`);
      // Check if can check, otherwise fold
      const p = engine.players.get(playerName);
      if (p && engine._currentBet <= p.bet) {
        engine.act(playerName, 'check');
      } else {
        engine.act(playerName, 'fold');
      }
    }
  }, TURN_TIMEOUT);
}

engine.on('action_required', (data) => {
  log.info(`  ★ Waiting: ${data.player} (call $${data.callAmount}, pot $${data.pot})`);
  startTurnTimer(data.player);
  sendStateToAll();

  // Notify the specific player
  for (const [ws, client] of clients) {
    if (client.playerName === data.player) {
      sendTo(ws, 'your_turn', { ...data, turnDeadline });
    }
  }
});

engine.on('player_acted', (data) => {
  clearTurnTimer();
  log.info(`  ${data.player}: ${data.action}${data.amount ? ' $' + data.amount : ''}`);
  const act = ACT_NAME[data.action] || data.action;
  const actionStr = data.amount ? `${data.player} ${act} ${data.amount}` : `${data.player} ${act}`;
  logEvent({ type: 'action', hand: currentHandNumber, action: actionStr });
  sendStateToAll();
});

engine.on('board_dealt', (data) => {
  log.info(`  ${data.phase.toUpperCase()}: ${data.cards.join(' ')}`);
  logEvent({ type: 'board', hand: currentHandNumber, cards: [...engine.communityCards] });
  sendStateToAll();
});

engine.on('hand_end', (data) => {
  clearTurnTimer();
  const winners = data.results.map(r => `${r.winner} wins $${r.amount}${r.hand ? ' (' + r.hand + ')' : ''}`);
  log.info(`  RESULT: ${winners.join(', ')}`);

  // Collect end stacks
  const stacks = {};
  for (const name of engine.seatOrder) {
    const p = engine.players.get(name);
    if (p) stacks[name] = p.stack;
  }
  // Collect shown cards (players who went to showdown without folding)
  const shown = [];
  if (data.players) {
    for (const p of data.players) {
      if (p.cards && p.cards.length > 0 && !p.folded) shown.push(p.name);
    }
  }
  const results = (data.results || []).map(r =>
    `${r.winner} ${r.amount}${r.hand ? ' ' + r.hand : ''}`
  );
  logEvent({ type: 'hand_end', hand: currentHandNumber, results, shown, stacks });
  log.info(`  History: hand #${currentHandNumber} recorded`);

  // Broadcast to all — information-isolated (fold = no cards)
  const publicPlayers = (data.players || []).map(p => {
    const obj = { name: p.name, seat: p.seat, stack: p.stack, folded: p.folded };
    if (p.cards && p.cards.length > 0 && !p.folded) {
      obj.cards = p.cards;  // shown at showdown
    }
    return obj;
  });
  broadcast('hand_result', {
    handNumber: engine.handNumber,
    positions: engine.getPositions(),
    results: data.results,
    board: data.board,
    players: publicPlayers,
    pot: data.pot,
    actions: [...engine.actions],
    blinds: [SB, BB],
  });
  sendStateToAll();

  // Auto-rebuy: any busted player gets auto-rebuyed
  for (const name of engine.seatOrder) {
    const p = engine.players.get(name);
    if (p && p.stack <= 0) {
      const result = engine.rebuy(name, STACK);
      if (result.ok) {
        log.info(`  Auto-rebuy: ${name} → $${STACK}`);
      }
    }
  }
});

engine.on('player_joined', (data) => {
  log.info(`+ ${data.name} joined (seat ${data.seat}, $${data.stack})`);
  broadcast('player_joined', data);
  sendStateToAll();
});

engine.on('player_left', (data) => {
  log.info(`- ${data.name} left`);
  broadcast('player_left', data);
  sendStateToAll();
});

engine.on('player_busted', (data) => {
  log.info(`✗ ${data.name} busted`);
  broadcast('player_busted', data);
});

engine.on('player_rebuy', (data) => {
  log.info(`💰 ${data.name} rebuys for $${data.amount} (stack: $${data.newStack})`);
  broadcast('player_rebuy', data);
  sendStateToAll();
});

engine.on('waiting_for_players', (data) => {
  log.info(`Waiting for players (${data.ready}/${data.needed})`);
});

engine.on('player_kicked', (data) => {
  log.info(`🚫 ${data.name} kicked from table`);
  broadcast('player_kicked', data);
  sendStateToAll();
});

engine.on('player_sit_out', (data) => {
  log.info(`💤 ${data.name} sitting out`);
  broadcast('player_sit_out', data);
  sendStateToAll();
});

engine.on('player_sit_back', (data) => {
  log.info(`🔙 ${data.name} sitting back in`);
  broadcast('player_sit_back', data);
  sendStateToAll();
});

engine.on('game_paused', () => {
  log.info('⏸  Game paused');
  broadcast('game_paused', {});
  sendStateToAll();
});

engine.on('game_resumed', () => {
  log.info('▶️  Game resumed');
  broadcast('game_resumed', {});
  sendStateToAll();
});

engine.on('settings_changed', (data) => {
  log.info(`⚙️  Settings changed: blinds ${data.smallBlind}/${data.bigBlind}, autoStart=${data.autoStart}`);
  broadcast('settings_changed', data);
  sendStateToAll();
});

engine.on('error', (data) => {
  log.warn(`Engine: ${data.message}`);
});

// ══════════════════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════════════════

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET / → poker table HTML
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = fs.readFileSync(TABLE_HTML, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500); res.end('poker-table.html not found');
    }
    return;
  }

  // GET /state → current state (for CC / polling fallback)
  // GET /state?player=Name → player-specific view (only their cards visible)
  if (req.method === 'GET' && (req.url === '/state' || req.url.startsWith('/state?'))) {
    const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const playerName = params.get('player');
    const state = playerName ? engine.getPlayerState(playerName) : engine.getState();
    state.timestamp = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }

  // GET /info → server info
  if (req.method === 'GET' && req.url === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      players: engine.seatOrder.map(name => {
        const p = engine.players.get(name);
        return { name, stack: p.stack, seat: p.seat, connected: p.connected };
      }),
      phase: engine.phase,
      blinds: `${SB}/${BB}`,
      handNumber: engine.handNumber,
    }));
    return;
  }

  // GET /config → current config
  // POST /config → update config (e.g. {"turnTimeout": 180000})
  if (req.url === '/config' || req.url.startsWith('/config?')) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ turnTimeout: TURN_TIMEOUT, stack: STACK, smallBlind: SB, bigBlind: BB }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const cfg = JSON.parse(body);
          if (cfg.turnTimeout != null) TURN_TIMEOUT = Number(cfg.turnTimeout);
          if (cfg.stack != null) STACK = Number(cfg.stack);
          if (cfg.smallBlind != null) { SB = Number(cfg.smallBlind); engine.sb = SB; }
          if (cfg.bigBlind != null) { BB = Number(cfg.bigBlind); engine.bb = BB; }
          log.info(`⚙ Config updated: timeout=${TURN_TIMEOUT}ms blinds=${SB}/${BB} stack=${STACK}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, turnTimeout: TURN_TIMEOUT, stack: STACK, smallBlind: SB, bigBlind: BB }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
  }

  // GET /history?player=Name&last=N → hand history with information isolation
  // GET /history?last=N → raw events (admin/spectator view)
  // GET /history?player=Name&last=N&raw=1 → raw events filtered per player
  if (req.method === 'GET' && (req.url === '/history' || req.url.startsWith('/history?'))) {
    try {
      const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
      const playerName = params.get('player');
      const lastN = parseInt(params.get('last') || '0');
      const rawMode = params.get('raw') === '1';
      const fileContent = fs.existsSync(HISTORY_FILE) ? fs.readFileSync(HISTORY_FILE, 'utf-8').trim() : '';
      if (!fileContent) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }
      const events = fileContent.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

      // Reconstruct hands from event stream
      const hands = [];
      let cur = null;
      for (const ev of events) {
        if (ev.type === 'hand_start') {
          cur = { ...ev };  // hand, blinds, positions, players
          cur.actions = [];
          cur.board = [];
          delete cur.type;
        } else if (ev.type === 'action' && cur && ev.hand === cur.hand) {
          cur.actions.push(ev.action);
        } else if (ev.type === 'board' && cur && ev.hand === cur.hand) {
          cur.board = ev.cards;
        } else if (ev.type === 'hand_end' && cur && ev.hand === cur.hand) {
          cur.results = ev.results;
          cur.shown = ev.shown;
          cur.stacks = ev.stacks;
          hands.push(cur);
          cur = null;
        }
      }
      // If there's an in-progress hand, include it as incomplete
      if (cur) {
        cur.incomplete = true;
        hands.push(cur);
      }

      // Trim to last N hands
      let result = lastN > 0 ? hands.slice(-lastN) : hands;

      // Information isolation per player
      if (playerName) {
        result = result.map(h => {
          const filtered = { ...h, players: {} };
          const shown = new Set(h.shown || []);
          for (const [name, pData] of Object.entries(h.players || {})) {
            if (name === playerName) {
              filtered.players[name] = pData; // own cards always visible
            } else if (shown.has(name)) {
              filtered.players[name] = pData; // shown at showdown
            } else {
              filtered.players[name] = [[], pData[1]]; // hidden cards, keep stack
            }
          }
          delete filtered.shown;
          return filtered;
        });
      }

      // Raw mode: return events instead of reconstructed hands
      if (rawMode) {
        let rawEvents = events;
        if (lastN > 0) {
          // Get events belonging to the last N hands
          const handNums = result.map(h => h.hand);
          rawEvents = events.filter(ev => handNums.includes(ev.hand));
        }
        // Filter cards in hand_start for player isolation
        if (playerName) {
          rawEvents = rawEvents.map(ev => {
            if (ev.type === 'hand_start' && ev.players) {
              const shown = new Set(); // no shown info yet at hand_start
              const filtered = { ...ev, players: {} };
              for (const [name, pData] of Object.entries(ev.players)) {
                if (name === playerName) {
                  filtered.players[name] = pData;
                } else {
                  filtered.players[name] = [[], pData[1]];
                }
              }
              return filtered;
            }
            if (ev.type === 'hand_end') {
              const copy = { ...ev };
              delete copy.shown;
              return copy;
            }
            return ev;
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rawEvents));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /action → player action (for CC / HTTP fallback)
  if (req.method === 'POST' && req.url === '/action') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const { player, action, amount } = JSON.parse(body);
        if (!player || !action) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Need player + action' }));
          return;
        }
        const result = engine.act(player, action, amount);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /join → player join (HTTP fallback)
  if (req.method === 'POST' && req.url === '/join') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const { name, stack, seat } = JSON.parse(body);
        const result = engine.addPlayer(name, stack || STACK, seat);
        if (result.ok && engine.phase !== 'waiting') {
          // Mid-hand join: sit out until next hand
          const p = engine.players.get(name);
          if (p) p.sittingOut = true;
        }
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /sit → change seat {name, seat}
  if (req.method === 'POST' && req.url === '/sit') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const { name, seat } = JSON.parse(body);
        const player = engine.players.get(name);
        if (!player) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Player not found' }));
          return;
        }
        if (seat === undefined || seat === null || seat < 0 || seat >= engine.maxPlayers) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Invalid seat (0-${engine.maxPlayers - 1})` }));
          return;
        }
        // Check if seat is taken by another player
        for (const [pName, p] of engine.players) {
          if (pName !== name && p.seat === seat) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `Seat ${seat} taken by ${pName}` }));
            return;
          }
        }
        const oldSeat = player.seat;
        player.seat = seat;
        engine._updateSeatOrder();
        log.info(`💺 ${name} moved from seat ${oldSeat} to seat ${seat}`);
        broadcast('player_moved', { name, oldSeat, newSeat: seat });
        sendStateToAll();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, oldSeat, newSeat: seat }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /start → host starts the game (enables autoStart + starts first hand)
  if (req.method === 'POST' && req.url === '/start') {
    if (engine.autoStart) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Already running' }));
      return;
    }
    const ready = engine._readyPlayers().length;
    if (ready < 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `Need at least 2 players (have ${ready})` }));
      return;
    }
    engine.updateSettings({ autoStart: true });
    engine.startHand();
    log.info(`🟢 Game started by host (${ready} players)`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: ready }));
    return;
  }

  // POST /rebuy → player rebuy {name, amount}
  if (req.method === 'POST' && req.url === '/rebuy') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const { name, amount } = JSON.parse(body);
        const result = engine.rebuy(name, amount || STACK);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
});

// ══════════════════════════════════════════════════
// WEBSOCKET SERVER
// ══════════════════════════════════════════════════

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.set(ws, { playerName: null, authenticated: false });
  log.info(`WS connected (${clients.size} total)`);

  // Send server info
  sendTo(ws, 'welcome', {
    blinds: `${SB}/${BB}`,
    defaultStack: STACK,
    players: engine.seatOrder.map(name => {
      const p = engine.players.get(name);
      return { name, stack: p.stack, seat: p.seat };
    }),
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const client = clients.get(ws);

    switch (msg.type) {
      // ── Join game ──
      case 'join': {
        const name = (msg.name || '').trim();
        if (!name) { sendTo(ws, 'error', { message: 'Name required' }); return; }

        const result = engine.addPlayer(name, msg.stack || STACK);
        if (result.ok) {
          client.playerName = name;
          client.authenticated = true;
          sendTo(ws, 'joined', { name, seat: result.seat, stack: msg.stack || STACK });

          // Send initial state
          const state = engine.getPlayerState(name);
          sendTo(ws, 'state', { state });
        } else {
          sendTo(ws, 'error', { message: result.error });
        }
        break;
      }

      // ── Game action ──
      case 'action': {
        if (!client.playerName) { sendTo(ws, 'error', { message: 'Join first' }); return; }
        const result = engine.act(client.playerName, msg.action, msg.amount);
        if (!result.ok) {
          sendTo(ws, 'error', { message: result.error });
        }
        break;
      }

      // ── Chat ──
      case 'chat': {
        if (!client.playerName) return;
        broadcast('chat', {
          player: client.playerName,
          message: (msg.message || '').substring(0, 200),
          time: new Date().toISOString(),
        });
        break;
      }

      // ── Leave ──
      case 'leave': {
        if (client.playerName) {
          engine.removePlayer(client.playerName);
          client.playerName = null;
        }
        break;
      }

      // ── Rebuy ──
      case 'rebuy': {
        if (!client.playerName) { sendTo(ws, 'error', { message: 'Join first' }); return; }
        const result = engine.rebuy(client.playerName, msg.amount || STACK);
        if (!result.ok) {
          sendTo(ws, 'error', { message: result.error });
        }
        break;
      }

      // ── Host commands ──
      case 'start': {
        engine.startHand();
        break;
      }

      case 'pause': {
        const r = engine.pause();
        if (!r.ok) sendTo(ws, 'error', { message: r.error });
        break;
      }

      case 'resume': {
        const r = engine.resume();
        if (!r.ok) sendTo(ws, 'error', { message: r.error });
        break;
      }

      case 'kick': {
        const target = (msg.name || '').trim();
        if (!target) { sendTo(ws, 'error', { message: 'No player specified' }); break; }
        const r = engine.kick(target);
        if (!r.ok) sendTo(ws, 'error', { message: r.error });
        // Also close kicked player's WS
        for (const [clientWs, clientData] of clients.entries()) {
          if (clientData.playerName === target) {
            sendTo(clientWs, 'kicked', { message: 'You have been kicked from the table' });
            clientData.playerName = null;
          }
        }
        break;
      }

      case 'sit_out': {
        if (!client.playerName) { sendTo(ws, 'error', { message: 'Join first' }); break; }
        const r = engine.sitOut(client.playerName);
        if (!r.ok) sendTo(ws, 'error', { message: r.error });
        break;
      }

      case 'sit_back': {
        if (!client.playerName) { sendTo(ws, 'error', { message: 'Join first' }); break; }
        const r = engine.sitBack(client.playerName);
        if (!r.ok) sendTo(ws, 'error', { message: r.error });
        break;
      }

      case 'settings': {
        const r = engine.updateSettings(msg);
        if (!r.ok) sendTo(ws, 'error', { message: r.error });
        break;
      }

      // ── Reconnect (name already taken = rejoin) ──
      case 'reconnect': {
        const name = (msg.name || '').trim();
        const p = engine.players.get(name);
        if (p) {
          client.playerName = name;
          client.authenticated = true;
          p.connected = true;
          sendTo(ws, 'joined', { name, seat: p.seat, stack: p.stack, reconnected: true });

          const state = engine.getPlayerState(name);
          sendTo(ws, 'state', { state });
        } else {
          sendTo(ws, 'error', { message: 'Player not found, use join instead' });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client?.playerName) {
      const p = engine.players.get(client.playerName);
      if (p) p.connected = false;
      log.info(`WS disconnected: ${client.playerName}`);
      // Don't remove from game — allow reconnect
      // Auto-fold after timeout if it's their turn (in the same hand)
      const disconnectName = client.playerName;
      const disconnectHand = engine.handNumber;
      setTimeout(() => {
        const p = engine.players.get(disconnectName);
        if (p && !p.connected &&
            engine.handNumber === disconnectHand &&
            engine.seatOrder[engine._currentPlayerIdx] === disconnectName) {
          log.warn(`Auto-fold for disconnected player: ${disconnectName}`);
          engine.act(disconnectName, 'fold');
        }
      }, 30000); // 30s disconnect timeout
    }
    clients.delete(ws);
  });
});

// ══════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════

server.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  PokerBot — Self-Hosted Texas Hold'em            ║
║                                                  ║
║  Local:   http://localhost:${String(PORT).padEnd(23)}║
║  Blinds:  ${blindsStr.padEnd(39)}║
║  Stack:   $${String(STACK).padEnd(38)}║
║                                                  ║
║  API:                                            ║
║  GET  /state  — game state (JSON)                ║
║  POST /join   — {name, stack}                    ║
║  POST /action — {player, action, amount}         ║
╚══════════════════════════════════════════════════╝`);

  // ── Public tunnel (--public flag) ──
  if (PUBLIC) {
    try {
      const localtunnel = require('localtunnel');
      const opts = { port: PORT };
      if (TUNNEL_SUBDOMAIN) opts.subdomain = TUNNEL_SUBDOMAIN;

      log.info('Opening public tunnel...');
      const tunnel = await localtunnel(opts);
      console.log(`
╔══════════════════════════════════════════════════╗
║  PUBLIC ACCESS ENABLED                           ║
║                                                  ║
║  Share this link:                                ║
║  → ${tunnel.url.padEnd(47)}║
║                                                  ║
║  Anyone with this URL can join your table!       ║
╚══════════════════════════════════════════════════╝`);

      tunnel.on('close', () => {
        log.warn('Tunnel closed — remote players disconnected');
      });
      tunnel.on('error', (e) => {
        log.error('Tunnel error:', e.message);
      });
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        console.log(`
  ⚠  --public requires localtunnel. Install it:
     npm install localtunnel
     Then re-run with --public`);
      } else {
        log.error('Tunnel failed:', e.message);
      }
    }
  }
});
