#!/usr/bin/env node
/**
 * poker-client.js — Universal WebSocket Client for poker-server
 *
 * Connects to any poker-server (local or remote) as a player/spectator.
 * Receives WebSocket messages, writes local state.json + history.jsonl,
 * and optionally serves poker-table.html for browser visualization.
 *
 * Use cases:
 *   - CC joins someone else's poker-server for coaching
 *   - Remote spectator with local history recording
 *   - Any client that needs persistent local game records
 *
 * Usage:
 *   node poker-client.js ws://192.168.1.5:3457 --name Enyan --port 3456
 *   node poker-client.js ws://friend.example.com:3457 --name CoachBot
 *
 * Files written (in game-data/<name>/):
 *   state.json           — always-current game state (CC reads this)
 *   history/<ts>.jsonl    — per-session history (rotates at 100 hands)
 *
 * Also serves poker-table.html on --port (default 3456) so you can
 * open localhost:3456 in browser to see the game.
 */

const path = require('path');
const fs   = require('fs');
const http = require('http');
const WebSocket = require('ws');

// ── Parse CLI args ──────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    serverUrl: '',
    name: 'CoachBot',
    httpPort: 3456,
  };

  // First positional arg = server URL
  if (args.length > 0 && !args[0].startsWith('--')) {
    config.serverUrl = args[0];
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1])  config.name = args[++i];
    if (args[i] === '--port' && args[i + 1])  config.httpPort = parseInt(args[++i]);
    if (args[i] === '--url' && args[i + 1])   config.serverUrl = args[++i];
  }

  if (!config.serverUrl) {
    console.error('Usage: node poker-client.js <ws://server:port> [--name Name] [--port 3456]');
    process.exit(1);
  }

  return config;
}

const CONFIG = parseArgs();

// ── Paths ───────────────────────────────────────
const PROJECT_ROOT = path.join(__dirname, '..');
const PROFILE_DIR  = path.join(PROJECT_ROOT, 'game-data', CONFIG.name);
const STATE_FILE   = path.join(PROFILE_DIR, 'state.json');
const HISTORY_DIR  = path.join(PROFILE_DIR, 'history');
const TABLE_HTML   = path.join(__dirname, 'public', 'poker-table.html');

try {
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
} catch (e) {
  console.error(`Failed to create data directories: ${e.message}`);
  process.exit(1);
}

// History file: one per session, rotate at 100 hands
const MAX_HANDS_PER_FILE = 100;
let historyFile = path.join(HISTORY_DIR, new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.jsonl');
let historyHandCount = 0;

// ── Helpers ─────────────────────────────────────
function writeJSON(fp, data) {
  try { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); } catch (e) {
    log.warn(`Failed to write ${path.basename(fp)}: ${e.message}`);
  }
}

let _rotating = false; // guard against concurrent rotation

function logEvent(event) {
  const ordered = { ts: new Date().toISOString(), ...event };
  // Rotate file after MAX_HANDS_PER_FILE hands (with guard)
  if (event.type === 'hand_start') {
    if (historyHandCount >= MAX_HANDS_PER_FILE && !_rotating) {
      _rotating = true;
      historyFile = path.join(HISTORY_DIR, new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.jsonl');
      historyHandCount = 0;
      _rotating = false;
    }
    historyHandCount++;
  }
  try { fs.appendFileSync(historyFile, JSON.stringify(ordered) + '\n'); } catch (e) {
    log.warn(`Failed to write history: ${e.message}`);
  }
}

const ACT_NAME = {
  call: 'call', check: 'check', fold: 'fold', bet: 'bet', raise: 'raise',
  small_blind: 'sb', big_blind: 'bb',
};

const log = {
  info: (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args),
  warn: (...args) => console.warn(`[${new Date().toISOString().slice(11, 19)}] ⚠`, ...args),
};

// ── State ───────────────────────────────────────
let currentState = null;
let myCards = [];
let currentHandNum = 0;
let joined = false;

// ══════════════════════════════════════════════════
// UPSTREAM CONNECTION (to remote poker-server)
// ══════════════════════════════════════════════════
let upstream = null;
let reconnectTimer = null;

function connectUpstream() {
  log.info(`Connecting to ${CONFIG.serverUrl} as "${CONFIG.name}"...`);

  try { upstream = new WebSocket(CONFIG.serverUrl); } catch (e) {
    log.warn('Connection failed:', e.message);
    scheduleReconnect();
    return;
  }

  upstream.on('open', () => {
    log.info('Connected to server');
    // Join the game
    upstream.send(JSON.stringify({ type: joined ? 'reconnect' : 'join', name: CONFIG.name }));
  });

  upstream.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleServerMessage(msg);
      // Forward to browser clients
      wsBroadcast(msg);
    } catch (e) {
      log.warn(`Failed to handle server message: ${e.message}`);
    }
  });

  upstream.on('close', () => {
    log.warn('Disconnected from server');
    scheduleReconnect();
  });

  upstream.on('error', () => {});
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectUpstream();
  }, 3000);
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      log.info(`Server: blinds=${msg.blinds}, stack=$${msg.defaultStack}, players=${(msg.players || []).map(p => p.name).join(', ') || 'none'}`);
      break;

    case 'joined':
      joined = true;
      log.info(`Joined as ${msg.name} (seat ${msg.seat}, $${msg.stack})`);
      break;

    case 'state':
      currentState = msg.state;
      writeJSON(STATE_FILE, currentState);
      break;

    case 'cards':
      myCards = msg.cards || [];
      log.info(`My cards: ${myCards.join(' ')}`);
      if (currentState) {
        currentState.myCards = myCards;
        writeJSON(STATE_FILE, currentState);
      }
      // Write hand_start when we receive our cards (= new hand dealt)
      if (currentState && currentState.handNumber && currentState.handNumber !== currentHandNum) {
        currentHandNum = currentState.handNumber;
        const players = {};
        for (const p of (currentState.players || [])) {
          if (p.name === CONFIG.name) {
            players[p.name] = [[...myCards], p.stack + (p.bet || 0)];
          } else {
            players[p.name] = [[], p.stack + (p.bet || 0)];
          }
        }
        logEvent({
          type: 'hand_start',
          hand: currentHandNum,
          blinds: [currentState.smallBlind, currentState.bigBlind],
          positions: currentState.positions || {},
          players,
        });
      }
      break;

    case 'your_turn':
      log.info(`★ MY TURN! call=$${msg.callAmount}, pot=$${msg.pot}`);
      if (currentState) {
        currentState.isMyTurn = true;
        currentState.callAmount = msg.callAmount;
        currentState.minRaise = msg.minRaise;
        currentState.maxRaise = msg.maxRaise;
        writeJSON(STATE_FILE, currentState);
      }
      break;

    case 'hand_result': {
      const hn = msg.handNumber || currentHandNum;
      const resultStrs = (msg.results || []).map(r =>
        `${r.winner} ${r.amount}${r.hand ? ' ' + r.hand : ''}`
      );
      log.info(`RESULT: ${resultStrs.join(', ')}`);

      // Write actions
      for (const a of (msg.actions || [])) {
        const act = ACT_NAME[a.action] || a.action;
        const actionStr = a.amount ? `${a.actor} ${act} ${a.amount}` : `${a.actor} ${act}`;
        logEvent({ type: 'action', hand: hn, action: actionStr });
      }
      // Write board
      if (msg.board && msg.board.length >= 3) {
        logEvent({ type: 'board', hand: hn, cards: msg.board });
      }
      // Write hand_end — information-isolated
      const stacks = {};
      const shown = [];
      for (const p of (msg.players || [])) {
        stacks[p.name] = p.stack;
        if (p.cards && p.cards.length > 0 && !p.folded) shown.push(p.name);
      }
      logEvent({ type: 'hand_end', hand: hn, results: resultStrs, shown, stacks });

      myCards = [];
      break;
    }

    case 'player_joined':
      log.info(`+ ${msg.name} joined`);
      break;

    case 'player_left':
      log.info(`- ${msg.name} left`);
      break;

    case 'player_busted':
      log.info(`✗ ${msg.name} busted`);
      break;

    case 'player_rebuy':
      log.info(`💰 ${msg.name} rebuys for $${msg.amount} (stack: $${msg.newStack})`);
      break;

    case 'chat':
      log.info(`Chat: ${msg.player}: ${msg.message}`);
      break;

    case 'error':
      log.warn(`Server error: ${msg.message}`);
      if (msg.message === 'Name taken' && upstream && upstream.readyState === WebSocket.OPEN) {
        log.info('Attempting reconnect...');
        upstream.send(JSON.stringify({ type: 'reconnect', name: CONFIG.name }));
      }
      break;
  }
}

// ══════════════════════════════════════════════════
// LOCAL HTTP + WS SERVER (for browser visualization)
// ══════════════════════════════════════════════════
const browserClients = new Set();

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve poker-table.html
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(TABLE_HTML, 'utf-8'));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('poker-table.html not found: ' + e.message);
    }
    return;
  }

  // GET /state
  if (req.method === 'GET' && (req.url === '/state' || req.url.startsWith('/state?'))) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(currentState || { phase: 'waiting', players: [] }));
    return;
  }

  // GET /history — read from history directory (information-isolated)
  // ?sessions → list available session files
  // ?session=<filename> → read specific session
  // ?last=N → last N hands from most recent session(s)
  // (no params) → all hands from current session
  if (req.method === 'GET' && (req.url === '/history' || req.url.startsWith('/history?'))) {
    try {
      const params = new URL(req.url, `http://localhost:${CONFIG.httpPort}`).searchParams;

      // List available sessions
      if (params.has('sessions')) {
        const files = fs.existsSync(HISTORY_DIR)
          ? fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl')).sort()
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(files));
        return;
      }

      // Determine which files to read
      let filesToRead = [];
      const sessionParam = params.get('session');
      if (sessionParam) {
        const fp = path.join(HISTORY_DIR, path.basename(sessionParam));
        if (fs.existsSync(fp)) filesToRead = [fp];
      } else {
        // Default: current session file. Also check legacy history.jsonl
        if (fs.existsSync(historyFile)) filesToRead = [historyFile];
        const legacyFile = path.join(PROFILE_DIR, 'history.jsonl');
        if (filesToRead.length === 0 && fs.existsSync(legacyFile)) filesToRead = [legacyFile];
      }

      // Parse events from selected files
      let events = [];
      for (const fp of filesToRead) {
        const content = fs.readFileSync(fp, 'utf-8').trim();
        if (content) {
          events = events.concat(content.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
        }
      }

      // Reconstruct hands
      const hands = [];
      let cur = null;
      for (const ev of events) {
        if (ev.type === 'hand_start') {
          cur = { ...ev }; cur.actions = []; cur.board = []; delete cur.type;
        } else if (ev.type === 'action' && cur && ev.hand === cur.hand) {
          cur.actions.push(ev.action);
        } else if (ev.type === 'board' && cur && ev.hand === cur.hand) {
          cur.board = ev.cards;
        } else if (ev.type === 'hand_end' && cur && ev.hand === cur.hand) {
          cur.results = ev.results; cur.shown = ev.shown; cur.stacks = ev.stacks;
          hands.push(cur); cur = null;
        }
      }
      if (cur) { cur.incomplete = true; hands.push(cur); }
      let lastN = parseInt(params.get('last') || '0', 10);
      if (isNaN(lastN) || lastN < 0) lastN = 0;
      const result = lastN > 0 ? hands.slice(-lastN) : hands;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /action → forward to upstream server
  if (req.method === 'POST' && req.url === '/action') {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 10000) { req.destroy(); }  // body size limit
    });
    req.on('end', () => {
      try {
        const action = JSON.parse(body);
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(JSON.stringify({ type: 'action', ...action }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Not connected to server' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /inject-state → push synthetic state to browser (for analysis/replay mode)
  if (req.method === 'POST' && req.url === '/inject-state') {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 50000) { req.destroy(); }
    });
    req.on('end', () => {
      try {
        const state = JSON.parse(body);
        currentState = state;
        writeJSON(STATE_FILE, currentState);
        wsBroadcast({ type: 'state', state });
        if (state.myCards) {
          myCards = state.myCards;
          wsBroadcast({ type: 'cards', cards: myCards });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // GET /config → proxy to upstream server
  if (req.method === 'GET' && req.url === '/config') {
    const http = require('http');
    const httpBase = CONFIG.serverUrl.replace(/^ws/, 'http');
    const upUrl = new URL('/config', httpBase);
    http.get(upUrl, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    }).on('error', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ turnTimeout: 180000 }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (clientWs) => {
  browserClients.add(clientWs);
  log.info(`Browser connected (${browserClients.size} total)`);

  // Send welcome + current state (autoJoinName tells browser to skip join screen)
  wsSend(clientWs, 'welcome', {
    blinds: currentState ? `${currentState.smallBlind}/${currentState.bigBlind}` : '10/20',
    defaultStack: 1000,
    players: currentState ? (currentState.players || []).map(p => ({ name: p.name, stack: p.stack })) : [],
    serverType: 'poker-client',
    autoJoinName: CONFIG.name,
  });

  if (currentState) {
    wsSend(clientWs, 'state', { state: currentState });
  }
  if (myCards.length > 0) {
    wsSend(clientWs, 'cards', { cards: myCards });
  }

  clientWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'join' || msg.type === 'reconnect') {
        // Use actual seat/stack from current state if available
        const me = currentState ? (currentState.players || []).find(p => p.name === CONFIG.name) : null;
        wsSend(clientWs, 'joined', {
          name: CONFIG.name,
          seat: me ? me.seat : 0,
          stack: me ? me.stack : 1000,
        });
        if (currentState) wsSend(clientWs, 'state', { state: currentState });
        if (myCards.length > 0) wsSend(clientWs, 'cards', { cards: myCards });
      } else if (msg.type === 'action' && upstream && upstream.readyState === WebSocket.OPEN) {
        // Forward action to upstream
        upstream.send(JSON.stringify(msg));
      }
    } catch (e) {
      log.warn(`Failed to handle browser message: ${e.message}`);
    }
  });

  clientWs.on('close', () => {
    browserClients.delete(clientWs);
  });
});

function wsSend(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function wsBroadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of browserClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
}

// ── Start ───────────────────────────────────────
httpServer.listen(CONFIG.httpPort, () => {
  log.info(`Local UI: http://localhost:${CONFIG.httpPort}`);
  log.info(`History:  ${historyFile}`);
  connectUpstream();
});

// ── Graceful shutdown ───────────────────────────
process.on('SIGINT', () => {
  log.info('Shutting down...');
  if (upstream) upstream.close();
  httpServer.close();
  process.exit(0);
});
