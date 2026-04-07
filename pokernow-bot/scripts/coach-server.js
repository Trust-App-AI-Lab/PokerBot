#!/usr/bin/env node
// coach-server.js — Local HTTP server for CoachBot state push
// Receives raw state from coach-bridge.js (browser), preprocesses and writes to filesystem.
// CC reads files directly with Read tool (instant, no javascript_tool needed).
//
// Usage:
//   node pokernow-bot/scripts/coach-server.js [gameUrl]
//   e.g. node pokernow-bot/scripts/coach-server.js https://www.pokernow.com/games/pglXXXX
//
// Endpoints:
//   POST /state   — full state snapshot → CoachBot/state.json (preprocessed)
//   POST /event   — single event → CoachBot/history.jsonl (append)
//   POST /turn    — turn notification → CoachBot/state.json + history.jsonl
//   GET  /health  — server alive check
//
// Preprocessing:
//   - Strips empty/null fields
//   - Replaces player IDs with names (via nameMap from log API)
//   - Flattens player objects to essential fields
//   - Compact output (~15 lines vs ~60 raw)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const COACH_DIR = path.join(PROJECT_ROOT, 'bot_profiles', 'CoachBot');
const STATE_FILE = path.join(COACH_DIR, 'state.json');
const HISTORY_FILE = path.join(COACH_DIR, 'history.jsonl');
const PID_FILE = path.join(COACH_DIR, 'coach-server.pid');

// Player name map: { playerId: displayName }
// Populated from PokerNow log API on first state push
let nameMap = {};
let gameUrl = process.argv[2] || null; // optional: pass game URL as arg

// Pending action: CC writes via POST /action, bridge polls via GET /action
let pendingAction = null;       // { action: "call", ts: "..." }
let actionResult = null;        // { ok: true, result: "OK: call", ts: "..." }

// ── Kill old instance via PID file ───────────────
function killOldInstance() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0); // test if alive
          process.kill(oldPid, 'SIGTERM');
          console.log(`[coach-server] Killed old instance (PID ${oldPid})`);
        } catch (e) {
          // Process already dead — just clean up stale PID file
        }
        fs.unlinkSync(PID_FILE);
      }
    }
  } catch (e) { /* ignore */ }
}
killOldInstance();

// Ensure CoachBot directory exists
if (!fs.existsSync(COACH_DIR)) {
  fs.mkdirSync(COACH_DIR, { recursive: true });
}

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[coach-server] ${ts().substring(11, 19)} ${msg}`);
}

// ── Fetch player names from PokerNow log API ────
async function fetchNameMap(gameId) {
  try {
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`https://www.pokernow.com/games/${gameId}/log`);
    const data = await res.json();
    const entries = data.logs || [];
    const nm = {};
    entries.forEach(function (entry) {
      const matches = entry.msg.match(/"(.+?) @ (\w+)"/g);
      if (matches) {
        matches.forEach(function (m) {
          const parts = m.match(/"(.+?) @ (\w+)"/);
          if (parts) nm[parts[2]] = parts[1];
        });
      }
    });
    nameMap = nm;
    log('Loaded ' + Object.keys(nm).length + ' player names from log API');
  } catch (e) {
    log('Failed to fetch names: ' + e.message);
  }
}

// ── Preprocess raw state → compact state ─────────
function compactState(raw) {
  const players = (raw.players || []).map(function (p) {
    const name = nameMap[p.id] || p.name || p.id;
    const cp = { name: name, stack: p.stack };
    if (p.bet) cp.bet = p.bet;
    if (p.folded) cp.folded = true;
    if (p.isMe) cp.me = true;
    if (p.cards && p.cards.length > 0) cp.cards = p.cards;
    return cp;
  });

  const s = {
    hand: raw.handNumber || 0,
    phase: raw.phase,
  };

  if (raw.myCards && raw.myCards.length > 0) s.myCards = raw.myCards;
  if (raw.communityCards && raw.communityCards.length > 0) s.board = raw.communityCards;
  s.pot = raw.pot || 0;
  s.myStack = raw.myStack || 0;
  s.isMyTurn = raw.isMyTurn || false;

  if (raw.isMyTurn) {
    if (raw.callAmount) s.call = raw.callAmount;
    s.minRaise = raw.minRaise || 0;
    s.maxRaise = raw.maxRaise || 0;
  }

  s.players = players;

  if (raw.actions && raw.actions.length > 0) {
    s.actions = raw.actions.map(function (a) {
      const ca = { who: nameMap[a.actor] || a.actor, do: a.action };
      if (a.amount) ca.amt = a.amount;
      return ca;
    });
  }

  return s;
}

// ── Compact history event ────────────────────────
function compactTurnEvent(raw) {
  const e = {
    ts: ts(),
    hand: raw.handNumber || raw.hand,
    phase: raw.phase,
    event: 'myTurn',
    pot: raw.pot,
    myStack: raw.myStack,
  };
  if (raw.myCards && raw.myCards.length > 0) e.myCards = raw.myCards;
  if (raw.communityCards && raw.communityCards.length > 0) e.board = raw.communityCards;
  if (raw.callAmount) e.call = raw.callAmount;
  if (raw.minRaise) e.minRaise = raw.minRaise;

  e.players = (raw.players || []).map(function (p) {
    const cp = { name: nameMap[p.id] || p.name || p.id, stack: p.stack };
    if (p.bet) cp.bet = p.bet;
    if (p.folded) cp.folded = true;
    return cp;
  });

  return e;
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString()); });
    req.on('error', reject);
  });
}

function writeState(data) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

function appendHistory(event) {
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(event) + '\n');
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Extract gameId from first state push ─────────
function tryExtractGameId(data) {
  if (gameUrl) return;
  // Try to get gameId from players — if we have player IDs, we can fetch names later
  // But we need the gameUrl. Bridge could send it, or we detect from first /state push.
  // For now, accept gameUrl as CLI arg or POST /config
}

const server = http.createServer(async function (req, res) {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ alive: true, pid: process.pid, uptime: process.uptime(), names: Object.keys(nameMap).length }));
    return;
  }

  // Bridge polls for pending action (every 1s)
  if (req.method === 'GET' && req.url === '/action') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (pendingAction) {
      const a = pendingAction;
      pendingAction = null; // consume once
      res.end(JSON.stringify(a));
    } else {
      res.end(JSON.stringify(null));
    }
    return;
  }

  // CC checks action result
  if (req.method === 'GET' && req.url === '/action-result') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(actionResult));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  try {
    const body = await readBody(req);
    const data = JSON.parse(body);

    if (req.url === '/config') {
      // Receive game config (gameUrl, etc.)
      if (data.gameUrl) {
        gameUrl = data.gameUrl;
        const gameId = gameUrl.match(/games\/([^/]+)/);
        if (gameId) await fetchNameMap(gameId[1]);
      }
      if (data.nameMap) {
        Object.assign(nameMap, data.nameMap);
        log('Updated nameMap: ' + Object.keys(nameMap).length + ' names');
      }
      res.writeHead(200);
      res.end('OK');

    } else if (req.url === '/action' && req.method === 'POST') {
      // CC sends action to execute: {"action": "call"} or {"action": "raise", "amount": 300}
      pendingAction = Object.assign({ ts: ts() }, data);
      actionResult = null; // clear previous result
      log('Action queued: ' + (data.action || 'unknown') + (data.amount ? ' ' + data.amount : ''));
      res.writeHead(200);
      res.end('OK');

    } else if (req.url === '/action-result') {
      // Bridge reports action execution result
      actionResult = Object.assign({ ts: ts() }, data);
      log('Action result: ' + JSON.stringify(data));
      res.writeHead(200);
      res.end('OK');

    } else if (req.url === '/state') {
      // Fetch names on first push if we have gameUrl but no names
      if (Object.keys(nameMap).length === 0 && gameUrl) {
        const gameId = gameUrl.match(/games\/([^/]+)/);
        if (gameId) await fetchNameMap(gameId[1]);
      }

      const compact = compactState(data);
      writeState(compact);
      log('State: hand #' + compact.hand + ' ' + compact.phase + ' pot=' + compact.pot);
      res.writeHead(200);
      res.end('OK');

    } else if (req.url === '/event') {
      const event = Object.assign({ ts: ts() }, data);
      // Resolve player names in handResult actions/results
      if (data.event === 'handResult') {
        if (Array.isArray(event.actions)) {
          event.actions = event.actions.map(function (a) {
            const ca = { who: nameMap[a.actor] || a.actor, do: a.action, phase: a.phase };
            if (a.amount) ca.amt = a.amount;
            return ca;
          });
        }
        if (Array.isArray(event.results)) {
          event.results = event.results.map(function (r) {
            return { winner: nameMap[r.winner] || r.winner, amt: r.amount };
          });
        }
        if (Array.isArray(event.players)) {
          event.players = event.players.map(function (p) {
            const cp = { name: nameMap[p.id] || p.name || p.id };
            if (p.cards && p.cards.length > 0) cp.cards = p.cards;
            if (p.folded) cp.folded = true;
            return cp;
          });
        }
        log('Hand #' + (event.hand || '?') + ' result: ' + JSON.stringify(event.results));
      }
      appendHistory(event);
      log('Event: ' + (data.event || 'unknown'));
      res.writeHead(200);
      res.end('OK');

    } else if (req.url === '/turn') {
      // Fetch names on first push if needed
      if (Object.keys(nameMap).length === 0 && gameUrl) {
        const gameId = gameUrl.match(/games\/([^/]+)/);
        if (gameId) await fetchNameMap(gameId[1]);
      }

      const compact = compactState(data);
      writeState(compact);
      appendHistory(compactTurnEvent(data));
      log('MY TURN — hand #' + compact.hand + ' ' + compact.phase + ' pot=' + compact.pot);
      res.writeHead(200);
      res.end('OK');

    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  } catch (e) {
    log('Error: ' + e.message);
    res.writeHead(400);
    res.end('Bad request: ' + e.message);
  }
});

server.listen(PORT, async function () {
  log('Listening on http://localhost:' + PORT);
  fs.writeFileSync(PID_FILE, String(process.pid));

  // If gameUrl provided as CLI arg, fetch names immediately
  if (gameUrl) {
    const gameId = gameUrl.match(/games\/([^/]+)/);
    if (gameId) await fetchNameMap(gameId[1]);
  }
});

// Graceful shutdown
function cleanup() {
  log('Shutting down...');
  try { fs.unlinkSync(PID_FILE); } catch (e) {}
  server.close();
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
