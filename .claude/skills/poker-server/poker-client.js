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
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// ── Parse CLI args ──────────────────────────────
// Name resolution order (so launch.json / preview_start can work without hardcoded --name):
//   1. --name CLI flag
//   2. $POKER_USER env var
//   3. game-data/.current-user file (written by start-game.sh)
//   4. 'CoachBot' fallback
function resolveName(cliName) {
  if (cliName) return cliName;
  if (process.env.POKER_USER) return process.env.POKER_USER;
  try {
    const root = path.join(__dirname, '..', '..', '..');
    const file = path.join(root, 'game-data', '.current-user');
    const name = fs.readFileSync(file, 'utf8').trim();
    if (name) return name;
  } catch (_) { /* fall through */ }
  return 'CoachBot';
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    serverUrl: 'ws://localhost:3457',
    name: null,
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

  config.name = resolveName(config.name);

  if (!config.serverUrl) {
    console.error('Usage: node poker-client.js <ws://server:port> [--name Name] [--port 3456]');
    process.exit(1);
  }

  return config;
}

const CONFIG = parseArgs();

// ── Paths ───────────────────────────────────────
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
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

// ── CoachBot session ID (matches start-game.sh: md5 of "coachbot-<name>") ──
function deriveCoachSid(name) {
  const hex = crypto.createHash('md5').update('coachbot-' + name).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}
const COACH_SID = deriveCoachSid(CONFIG.name);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

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
      // Diff the action log against the previous state so we can surface
      // every new seat action as a compact chip in the CoachBot panel.
      // Browser already receives the full state via wsBroadcast(msg) — the
      // 'log' role messages below are additive chat entries, not a replacement.
      {
        const prevCount = (currentState && (currentState.actions || []).length) || 0;
        const nextActions = (msg.state && msg.state.actions) || [];
        if (nextActions.length > prevCount) {
          const newActs = nextActions.slice(prevCount);
          const hn = (msg.state && msg.state.handNumber) || '?';
          for (const a of newActs) {
            const verb = ACT_NAME[a.action] || a.action;
            const isMe = a.actor === CONFIG.name;
            const amt = a.amount ? ` $${a.amount}` : '';
            // `content` is the plain-text fallback (used if the browser
            // doesn't know about structured log fields). `logData` carries
            // the structured payload so the browser can colorize
            // actor / verb / amount separately via .log-* spans.
            wsBroadcast({
              type: 'coach',
              role: 'log',
              content: `Hand #${hn} · ${a.actor}${isMe ? ' (me)' : ''} ${verb}${amt}`,
              logData: { hand: hn, actor: a.actor, isMe, verb, amount: a.amount || 0 },
              ts: new Date().toISOString(),
            });
          }
        }
      }
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
      // no-cache so HTML/JS/CSS edits land on the next normal refresh — not
      // only after a hard-refresh. Relay always reads from disk, but without
      // this header browsers cache the HTML indefinitely.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
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

  // POST /coach → broadcast a coach message to all browser clients.
  // Body: { content, role?, handNumber?, phase? }
  // Used by narrator.js (auto-analysis) and any external writer.
  if (req.method === 'POST' && req.url === '/coach') {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 50000) { req.destroy(); }
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.content || typeof payload.content !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing content' }));
          return;
        }
        wsBroadcast({
          type: 'coach',
          role: payload.role || 'assistant',
          content: payload.content,
          handNumber: payload.handNumber,
          phase: payload.phase,
          ts: payload.ts || new Date().toISOString(),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /coach-ask → ask CoachBot a question.
  // Body: { question, silent?, headline? }
  //   question  — prompt sent to claude -p --resume COACH_SID
  //   silent    — if true, do NOT echo user message to browser (for narrator)
  //   headline  — optional short user-visible line (shown instead of raw question)
  // Relay auto-prepends a fresh [CURRENT GAME STATE] block to the question so
  // CoachBot always reasons on live state — see buildStateBlock() below.
  // Always broadcasts the assistant reply, always shows the thinking indicator.
  // Returns { ok, content }.
  if (req.method === 'POST' && req.url === '/coach-ask') {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 20000) { req.destroy(); }
    });
    req.on('end', async () => {
      let question, silent = false, headline = null;
      try {
        const parsed = JSON.parse(body);
        question = parsed.question;
        silent = !!parsed.silent;
        headline = parsed.headline || null;
        if (!question || typeof question !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing question' }));
          return;
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
        return;
      }
      // Echo user message (unless silent). If silent + headline, show the headline instead.
      if (!silent) {
        wsBroadcast({
          type: 'coach',
          role: 'user',
          content: question,
          ts: new Date().toISOString(),
        });
      } else if (headline) {
        wsBroadcast({
          type: 'coach',
          role: 'system',
          content: headline,
          ts: new Date().toISOString(),
        });
      }
      // Count this invocation BEFORE dispatching — the counter drives the
      // periodic compact+reload maintenance (see MAINTENANCE_PROMPT).
      coachInvocationCount++;
      // If maintenance is due and it's safe to run (not my turn), fire it
      // first. maybeRunMaintenance() broadcasts its own thinking/system
      // messages and never throws. When it returns the counter is reset.
      await maybeRunMaintenance();
      // Notify browser CoachBot is thinking
      wsBroadcast({ type: 'coach-thinking', on: true });
      try {
        // Prepend a fresh [CURRENT GAME STATE] block so the subprocess CoachBot
        // always reasons on live state, not its stale session memory (it only
        // auto-refreshes on `your_turn` / `hand_result` from narrator). Format
        // mirrors narrator.js stateSummary — bounded by delimiters so CoachBot
        // can distinguish the context block from the actual user question.
        const fullQuestion = buildStateBlock() + '\n\n' + question;
        const reply = await runCoach(fullQuestion);
        wsBroadcast({ type: 'coach-thinking', on: false });
        // Strip action sentinel from last non-empty line, if present.
        // Contract: subprocess CoachBot emits `ACTION=<op> [AMOUNT=<N>]` on the
        // last line when the user issued an explicit action command (see
        // /coachbot SKILL.md → "Panel Action Routing"). Relay strips it from
        // the broadcast and internally forwards the action upstream.
        const { cleanReply, action } = extractActionSentinel(reply);
        wsBroadcast({
          type: 'coach',
          role: 'assistant',
          content: cleanReply,
          ts: new Date().toISOString(),
        });
        if (action) {
          // ── Relay-side validation ──
          // CoachBot's reply can be seconds late; the turn may already have
          // passed, or it may have picked an action that's illegal given the
          // current betting state. Catch these here instead of letting the
          // server reject them — cleaner UX + prevents narrator retry storms.
          const s = currentState || {};
          const ca = s.callAmount || 0;
          let rejectReason = null;
          if (!s.isMyTurn) {
            rejectReason = `Stale action — not my turn anymore (currentActor=${s.currentActor || 'none'}, phase=${s.phase || '?'}). Action dropped.`;
          } else if (action.action === 'check' && ca > 0) {
            rejectReason = `Illegal: "check" when callAmount=$${ca} > 0. You must call, raise, or fold.`;
          } else if (action.action === 'call' && ca === 0) {
            rejectReason = `Illegal: "call" when callAmount=$0. Use check instead.`;
          }
          if (rejectReason) {
            log.warn(`CoachBot action rejected by relay: ${JSON.stringify(action)} — ${rejectReason}`);
            wsBroadcast({
              type: 'coach',
              role: 'error',
              content: `⚠ Action dropped: ${rejectReason}`,
              ts: new Date().toISOString(),
            });
          } else if (upstream && upstream.readyState === WebSocket.OPEN) {
            upstream.send(JSON.stringify({ type: 'action', ...action }));
            log.info(`CoachBot sentinel → forwarded action: ${JSON.stringify(action)}`);
          } else {
            wsBroadcast({
              type: 'coach',
              role: 'error',
              content: 'CoachBot action dropped — not connected to server.',
              ts: new Date().toISOString(),
            });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, content: cleanReply, action: action || null }));
      } catch (e) {
        wsBroadcast({ type: 'coach-thinking', on: false });
        wsBroadcast({
          type: 'coach',
          role: 'error',
          content: 'CoachBot error: ' + e.message,
          ts: new Date().toISOString(),
        });
        res.writeHead(500, { 'Content-Type': 'application/json' });
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

// ══════════════════════════════════════════════════
// COACHBOT — serialized claude -p spawns against COACH_SID
// ══════════════════════════════════════════════════
// One subprocess at a time: concurrent --resume against the same
// session file corrupts history. FIFO queue guarantees serialization.
const coachQueue = [];
let coachBusy = false;
let coachSessionReady = false;  // becomes true after first successful spawn

// Init prompt used when the session doesn't exist yet (first run without start-game.sh
// pre-warm, or after a manual session wipe). Mirrors start-game.sh pre-warm.
const COACH_INIT_PROMPT =
  'Read .claude/skills/coachbot/SKILL.md and follow it throughout this session. ' +
  'Load /poker-strategy tier:pro (all 5 strategy docs) into context. ' +
  'When ready, wait for the user\'s next message.';

// ── Periodic session maintenance ──────────────────────────────
// Long sessions drift: the transcript grows, Claude Code may compact early
// turns (dropping the SKILL.md tool-result we seeded at init), and we start
// seeing symptoms — missing 🃏 prefix, forgotten legal-action rules, bad
// ACTION= sentinel format.
//
// Every COMPACT_INTERVAL invocations of runCoach() we fire a maintenance
// turn that (1) forces the model to self-summarize (compaction) and (2)
// re-Reads SKILL.md so the rules re-enter the working context as a fresh
// tool-result. Counter is only incremented for USER-FACING calls; the
// maintenance turn itself doesn't count.
let coachInvocationCount = 0;
let maintenanceInFlight = false;
const COMPACT_INTERVAL = parseInt(process.env.COACH_COMPACT_INTERVAL || '15', 10);
const MAINTENANCE_PROMPT = [
  '[SESSION MAINTENANCE — no user question this turn, no ACTION= sentinel]',
  '',
  'Your session transcript is getting long. Do the following to stay sharp:',
  '',
  '1. Summarize in 3–5 bullets what you\'ve learned about the user\'s play so far (leaks, strengths, recurring spots, villain reads). Keep it brief — this is compaction, not analysis.',
  '2. Re-Read `.claude/skills/coachbot/SKILL.md` to refresh: identity prefix (🃏 CoachBot:), tool-tagging (⚙/📖), language routing, legal-action rules, ACTION= sentinel contract.',
  '3. Reply with this line, nothing else:',
  '   refreshed',
  '',
  'Do NOT emit an ACTION= sentinel. Do NOT analyze the current hand. Just summarize → re-read → confirm.',
].join('\n');

function runCoach(question) {
  return new Promise((resolve, reject) => {
    coachQueue.push({ question, resolve, reject });
    drainCoachQueue();
  });
}

// Fire the maintenance turn if counter is due. Called BEFORE every real
// /coach-ask invocation. Skipped when it's the user's turn (don't delay a
// real in-game action with a 20-30s upkeep call). Never throws — failures
// log + fall through so gameplay is unaffected.
async function maybeRunMaintenance() {
  if (maintenanceInFlight) return;                         // one at a time
  if (coachInvocationCount < COMPACT_INTERVAL) return;     // not due yet
  if (currentState && currentState.isMyTurn) {
    // Defer: we'll catch it on the next off-turn /coach-ask.
    log.info(`maintenance due (count=${coachInvocationCount}) but my turn — deferring`);
    return;
  }
  maintenanceInFlight = true;
  log.info(`CoachBot maintenance starting (invocations=${coachInvocationCount}, interval=${COMPACT_INTERVAL})`);
  wsBroadcast({
    type: 'coach',
    role: 'system',
    content: `🔄 CoachBot 定期维护中（第 ${coachInvocationCount} 次调用触发，每 ${COMPACT_INTERVAL} 次一次）`,
    ts: new Date().toISOString(),
  });
  wsBroadcast({ type: 'coach-thinking', on: true });
  try {
    const reply = await runCoach(MAINTENANCE_PROMPT);
    const looksOk = /refresh|done|ready|complete|刷新|完成/i.test((reply || '').trim());
    if (looksOk) {
      log.info('✓ CoachBot maintenance done');
    } else {
      log.warn(`CoachBot maintenance reply unexpected (first 200 chars): ${(reply || '').trim().slice(0, 200)}`);
    }
    coachInvocationCount = 0;
    wsBroadcast({
      type: 'coach',
      role: 'system',
      content: '✓ CoachBot 刷新完成',
      ts: new Date().toISOString(),
    });
  } catch (e) {
    log.warn(`CoachBot maintenance failed: ${e.message}`);
    // Don't reset counter outright — retry next time. But cap to avoid a
    // permanent loop if the subprocess is broken.
    if (coachInvocationCount > COMPACT_INTERVAL * 2) coachInvocationCount = 0;
    wsBroadcast({
      type: 'coach',
      role: 'error',
      content: `CoachBot 维护失败: ${e.message}`,
      ts: new Date().toISOString(),
    });
  } finally {
    wsBroadcast({ type: 'coach-thinking', on: false });
    maintenanceInFlight = false;
  }
}

// Build a human-readable [CURRENT GAME STATE] block from the relay's live
// currentState + myCards. Prepended to every /coach-ask question so CoachBot
// reasons on fresh state instead of stale session memory. Format is
// intentionally compact and stable — delimited by [CURRENT GAME STATE] / [/STATE]
// so the subprocess can distinguish context from the actual question.
function buildStateBlock() {
  const ts = new Date().toTimeString().slice(0, 8);
  if (!currentState) {
    return `[CURRENT GAME STATE — ${ts}]\n(no game state yet — server not connected or no hand has started)\n[/STATE]`;
  }
  const s = currentState;
  const players = (s.players || []).map(p => {
    const tag = p.name === CONFIG.name ? '(me)' : '';
    const flags = [];
    if (p.folded) flags.push('FOLDED');
    if (p.allIn)  flags.push('ALL-IN');
    return `${p.name}${tag} seat=${p.seat} stack=$${p.stack} bet=$${p.bet || 0}${flags.length ? ' ' + flags.join(' ') : ''}`;
  }).join(' | ') || '(none)';
  const board = (s.communityCards || s.board || []).join(' ') || '(no board)';
  const cards = myCards.length ? myCards.join(' ') : (s.myCards && s.myCards.length ? s.myCards.join(' ') : '(hidden / not dealt)');
  const positions = s.positions ? JSON.stringify(s.positions) : '{}';
  const recent = (s.actions || s.recentActions || []).slice(-8).map(a =>
    `${a.actor} ${a.action}${a.amount ? ' ' + a.amount : ''}`
  ).join(' → ') || '(none)';
  // Legal-action derivation — mirrors the UI button logic in poker-table.html:
  //   callAmount === 0 → { check, fold, (bet minR-maxR if canRaise) }
  //   callAmount  > 0  → { call ca, fold, (raise minR-maxR if canRaise) }
  // Explicit list prevents CoachBot from emitting ACTION=check when a bet is
  // outstanding (previous bug: "Must call $100 or fold" rejections).
  let turnLine;
  if (s.isMyTurn) {
    const ca   = s.callAmount || 0;
    const minR = s.minRaise   || 0;
    const maxR = s.maxRaise   || 0;
    const canRaise = maxR >= minR && maxR > 0;
    const legal = [];
    if (ca === 0) {
      legal.push('check');
      legal.push('fold');
      if (canRaise) legal.push(`bet $${minR}-$${maxR}`);
    } else {
      legal.push(`call $${ca}`);
      legal.push('fold');
      if (canRaise) legal.push(`raise $${minR}-$${maxR} (total bet)`);
    }
    const warn = ca > 0
      ? '  ⚠ "check" is ILLEGAL here — you must call, raise, or fold.'
      : '';
    turnLine = `\n★ MY TURN — callAmount=$${ca} minRaise=$${minR} maxRaise=$${maxR}`
             + `\n★ LEGAL ACTIONS: ${legal.join(' | ')}${warn}`;
  } else if (s.currentActor) {
    turnLine = `\nCurrent actor: ${s.currentActor} (NOT my turn — do NOT emit an ACTION= sentinel)`;
  } else {
    turnLine = '';
  }
  return [
    `[CURRENT GAME STATE — ${ts}]`,
    `Hand #${s.handNumber || '?'} phase=${s.phase || '?'}`,
    `My name: ${CONFIG.name}`,
    `My cards: ${cards}`,
    `Board: ${board}`,
    `Pot: $${s.pot || 0}`,
    `Positions: ${positions}`,
    `Players: ${players}`,
    `Recent: ${recent}${turnLine}`,
    `[/STATE]`,
  ].join('\n');
}

// Parse the last non-empty line of a CoachBot reply for an action sentinel.
// Contract: `ACTION=<op> [AMOUNT=<N>]` where <op> ∈ fold|check|call|raise|bet.
// For raise/bet the AMOUNT is required (absolute total bet size). Returns
// { cleanReply, action } — if no sentinel, cleanReply === reply and action === null.
function extractActionSentinel(reply) {
  if (!reply || typeof reply !== 'string') return { cleanReply: reply, action: null };
  const lines = reply.split('\n');
  // Find last non-empty line
  let idx = lines.length - 1;
  while (idx >= 0 && lines[idx].trim() === '') idx--;
  if (idx < 0) return { cleanReply: reply, action: null };
  const last = lines[idx].trim();
  const m = last.match(/^ACTION=(fold|check|call|raise|bet)(?:\s+AMOUNT=(\d+))?$/i);
  if (!m) return { cleanReply: reply, action: null };
  const op = m[1].toLowerCase();
  const amt = m[2] ? parseInt(m[2], 10) : undefined;
  // raise/bet require an amount; if missing, treat as invalid sentinel
  if ((op === 'raise' || op === 'bet') && (amt === undefined || !Number.isFinite(amt))) {
    return { cleanReply: reply, action: null };
  }
  // Strip the sentinel line (and any trailing blank lines above it)
  lines.splice(idx);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const cleanReply = lines.join('\n');
  const action = { action: op };
  if (amt !== undefined) action.amount = amt;
  return { cleanReply, action };
}

// Spawn claude with the given args. Returns { code, stdout, stderr }.
function spawnClaude(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],  // no stdin — -p takes prompt as arg
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => resolve({ code, stdout, stderr }));
    proc.on('error', err => reject(err));
  });
}

// Detect the "No conversation found with session ID: ..." error from `claude --resume`.
// Happens on first run when start-game.sh wasn't used, or after session wipe.
function isSessionMissing(stderr) {
  return /No conversation found with session ID/i.test(stderr);
}

async function drainCoachQueue() {
  if (coachBusy || coachQueue.length === 0) return;
  coachBusy = true;
  const { question, resolve, reject } = coachQueue.shift();

  try {
    const baseArgs = [
      '--model', 'opus',
      '--permission-mode', 'bypassPermissions',
    ];

    // Try --resume first. If session missing, initialize with --session-id + init prompt,
    // then retry the user question with --resume.
    let result = await spawnClaude(['-p', question, '--resume', COACH_SID, ...baseArgs]);

    if (result.code !== 0 && isSessionMissing(result.stderr)) {
      log.info(`CoachBot session ${COACH_SID} not found — initializing...`);
      const init = await spawnClaude([
        '-p', COACH_INIT_PROMPT,
        '--session-id', COACH_SID,
        ...baseArgs,
      ]);
      if (init.code !== 0) {
        throw new Error('CoachBot init failed: ' + (init.stderr.trim() || `exit ${init.code}`));
      }
      log.info('✓ CoachBot session initialized');
      coachSessionReady = true;
      // Retry the actual question
      result = await spawnClaude(['-p', question, '--resume', COACH_SID, ...baseArgs]);
    }

    if (result.code === 0) {
      coachSessionReady = true;
      resolve(result.stdout.trim());
    } else {
      reject(new Error(result.stderr.trim() || `claude exited ${result.code}`));
    }
  } catch (err) {
    reject(err);
  } finally {
    coachBusy = false;
    drainCoachQueue();
  }
}

// ── Start ───────────────────────────────────────
httpServer.listen(CONFIG.httpPort, () => {
  log.info(`Local UI: http://localhost:${CONFIG.httpPort}`);
  log.info(`History:  ${historyFile}`);
  log.info(`CoachBot: SID ${COACH_SID}`);
  connectUpstream();
});

// ── Graceful shutdown ───────────────────────────
process.on('SIGINT', () => {
  log.info('Shutting down...');
  if (upstream) upstream.close();
  httpServer.close();
  process.exit(0);
});
