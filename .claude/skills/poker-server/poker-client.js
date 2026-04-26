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
const COACH_SKILL_MD = path.join(PROJECT_ROOT, '.claude', 'skills', 'coachbot', 'SKILL.md');

// Single source of truth for CoachBot's model: the frontmatter `model:`
// field in coachbot/SKILL.md. Both this relay and start-game.sh read the
// same file — change model there only. Falls back to 'sonnet' if the file
// is missing or malformed so the relay still starts.
function readCoachModel() {
  try {
    const raw = fs.readFileSync(COACH_SKILL_MD, 'utf8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const m = fm[1].match(/^model:\s*(\S+)\s*$/m);
      if (m) return m[1];
    }
  } catch { /* fall through */ }
  return 'sonnet';
}
const COACH_MODEL = readCoachModel();

try {
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
} catch (e) {
  console.error(`Failed to create data directories: ${e.message}`);
  process.exit(1);
}

// Per-process game identifier. Changes every time the relay (re)starts,
// which — under start-game.sh — means every fresh game. Sent to the browser
// in the 'welcome' message so the UI can auto-clear its localStorage-backed
// CoachBot chat history when it sees a new gameId (i.e. on start-game).
// Refresh within the same process keeps the same gameId → chat survives.
const GAME_ID = String(Date.now());

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

// Fire-and-forget HTTP POST to the upstream poker-server. Used to forward
// browser control commands (Start hand, Settings, etc.) that the upstream
// exposes as REST endpoints rather than WS messages. Errors are logged but
// never thrown — the browser UI will pick up state changes on the next WS
// `state` event anyway.
function upstreamPost(pathStr, body) {
  try {
    const u = new URL(pathStr, CONFIG.serverUrl.replace(/^ws/, 'http'));
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 2000,
    }, res => { res.resume(); });
    req.on('error', e => log.warn(`upstreamPost ${pathStr} failed: ${e.message}`));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(data); req.end();
  } catch (e) {
    log.warn(`upstreamPost ${pathStr} crashed: ${e.message}`);
  }
}

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
      // NOTE: we skip the legacy `coach-thinking` indicator for /coach-ask
      // because the streaming bubble (below) already shows activity via its
      // blinking-caret animation. Firing both produces a duplicate
      // "thinking..." row under the empty bubble. `coach-thinking` is still
      // used by maintenance (which doesn't stream).
      try {
        // Prepend a fresh [CURRENT GAME STATE] block so the subprocess CoachBot
        // always reasons on live state, not its stale session memory (it only
        // auto-refreshes on `your_turn` / `hand_result` from narrator). Format
        // mirrors narrator.js stateSummary — bounded by delimiters so CoachBot
        // can distinguish the context block from the actual user question.
        const fullQuestion = buildStateBlock() + '\n\n' + question;

        // Stream text deltas to the browser as they arrive so the user sees
        // the reasoning appear in real time, BEFORE the subprocess' Bash tool
        // call lands /action on the server. Without streaming, stdout is
        // buffered until claude exits — UI would then see action land first
        // and analysis appear after (bad UX).
        const streamId = `coach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ts = new Date().toISOString();
        // NOTE: don't broadcast `coach-stream-start` yet. If we fire it here
        // (at request time), every queued request creates an empty bubble
        // with a blinking cursor while it waits its turn — confusing when
        // multiple narrator+user asks pile up. Instead, the onEvent below
        // sends stream-start lazily on the first real event (first text
        // delta or first tool_use). A crashed/empty claude run → no bubble.
        let streamOpened = false;
        const openStream = () => {
          if (streamOpened) return;
          streamOpened = true;
          wsBroadcast({ type: 'coach-stream-start', id: streamId, role: 'assistant', ts });
        };

        // Tool-call bookkeeping per stream: content_block events carry only
        // `index`, so we track index → { type, toolUseId, name, partialJson }
        // to reassemble input across delta events and attach tool_result
        // (which arrives via a separate `user` message keyed by tool_use_id).
        const blocks = new Map();

        const onEvent = (evt) => {
          if (evt.type === 'stream_event' && evt.event) {
            const se = evt.event;
            // Block start: register; if tool_use, tell UI
            if (se.type === 'content_block_start' && se.content_block) {
              const cb = se.content_block;
              blocks.set(se.index, {
                type: cb.type,
                toolUseId: cb.id,
                name: cb.name,
                partial: '',
              });
              if (cb.type === 'tool_use') {
                openStream();
                wsBroadcast({
                  type: 'coach-tool-start',
                  id: streamId,
                  toolUseId: cb.id,
                  name: cb.name || '?',
                });
              }
            }
            // Deltas: text → push to UI; input_json → accumulate
            else if (se.type === 'content_block_delta' && se.delta) {
              if (se.delta.type === 'text_delta') {
                openStream();
                wsBroadcast({ type: 'coach-delta', id: streamId, text: se.delta.text || '' });
              } else if (se.delta.type === 'input_json_delta') {
                const block = blocks.get(se.index);
                if (block && block.type === 'tool_use') {
                  block.partial += se.delta.partial_json || '';
                }
              }
            }
            // Block stop: if it was a tool_use, parse the accumulated JSON
            // and push the final input down to UI.
            else if (se.type === 'content_block_stop') {
              const block = blocks.get(se.index);
              if (block && block.type === 'tool_use') {
                let input = {};
                try { input = JSON.parse(block.partial || '{}'); } catch {}
                wsBroadcast({
                  type: 'coach-tool-input',
                  id: streamId,
                  toolUseId: block.toolUseId,
                  input,
                });
              }
            }
          }
          // Tool result: arrives as a `user` message (not a stream_event).
          // Forward the text portion per tool_use_id so UI can attach it to
          // the right tool chip. Truncate large outputs at 4 KB.
          else if (evt.type === 'user' && evt.message && Array.isArray(evt.message.content)) {
            for (const c of evt.message.content) {
              if (c.type === 'tool_result') {
                let text = '';
                if (typeof c.content === 'string') text = c.content;
                else if (Array.isArray(c.content)) {
                  text = c.content
                    .filter(x => x && x.type === 'text')
                    .map(x => x.text || '').join('\n');
                }
                if (text.length > 4096) text = text.slice(0, 4096) + '\n…(truncated)';
                wsBroadcast({
                  type: 'coach-tool-output',
                  id: streamId,
                  toolUseId: c.tool_use_id,
                  content: text,
                });
              }
            }
          }
        };

        // Narrator auto-asks always come with `silent: true` (headline only,
        // no user message echo). A non-silent call means the user typed the
        // question — prioritize it so narrator's backlog of auto-turns
        // doesn't force the user to wait.
        const reply = await runCoach(fullQuestion, onEvent, !silent);
        // If the subprocess exited without ever streaming (no text, no
        // tool_use — e.g. empty reply), openStream never fired, so there's
        // no UI bubble to finalize. Skip the end event to avoid a dangling
        // stream-end targeting a non-existent bubble.
        if (streamOpened) {
          wsBroadcast({ type: 'coach-stream-end', id: streamId, content: reply, ts });
        }
        wsBroadcast({ type: 'coach-thinking', on: false });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, content: reply }));
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
    gameId: GAME_ID,
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
      } else if (msg.type === 'start') {
        // Browser's "Start" button (host deals the next hand). Upstream
        // exposes this as HTTP POST /start — forward over a small local
        // request. Non-blocking, fire-and-forget.
        upstreamPost('/start', {});
      } else if (msg.type === 'settings') {
        // Browser's settings panel Apply → HTTP POST /config on upstream.
        upstreamPost('/config', {
          smallBlind: msg.smallBlind,
          bigBlind:   msg.bigBlind,
          autoStart:  msg.autoStart,
        });
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

// Init prompt used when the session doesn't exist yet (first run without
// start-game.sh pre-warm, or after a manual session wipe). Mirrors
// start-game.sh pre-warm: load the two SKILL.md routers only, then let the
// bot Read individual strategy docs on-demand per turn (CoachBot SKILL.md
// explicitly calls out "don't bulk-load — compaction drift blurs pre-loaded
// content").
const COACH_INIT_PROMPT =
  'Read .claude/skills/coachbot/SKILL.md and follow it throughout this session. ' +
  'Also Read .claude/skills/poker-strategy/SKILL.md — tiny router (tools + doc index). ' +
  'Do NOT bulk-load the strategy docs; per-turn Read individual docs on-demand when the spot calls for them. ' +
  'When ready, wait for the user\'s next message.';

// ── Periodic session maintenance ──────────────────────────────
// Long sessions drift: the transcript grows, Claude Code may compact early
// turns (dropping the SKILL.md tool-result we seeded at init), and we start
// seeing symptoms — forgotten legal-action rules, skipped action curls,
// language-routing regressions.
//
// Every COMPACT_INTERVAL invocations of runCoach() we fire a maintenance
// turn that (1) forces the model to self-summarize (compaction) and (2)
// re-Reads SKILL.md so the rules re-enter the working context as a fresh
// tool-result. Counter is only incremented for USER-FACING calls; the
// maintenance turn itself doesn't count.
let coachInvocationCount = 0;
let maintenanceInFlight = false;
// Every COMPACT_INTERVAL user-facing /coach-ask invocations we fire a
// compaction turn (see MAINTENANCE_PROMPT). 30 was picked to cut the
// chance a maintenance run overlaps a user question roughly in half
// compared to the old 15. Sonnet maintenance ~15-20s — still short
// enough to not matter much when it does hit.
const COMPACT_INTERVAL = parseInt(process.env.COACH_COMPACT_INTERVAL || '30', 10);
const MAINTENANCE_PROMPT = [
  '[SESSION MAINTENANCE — no user question this turn, do NOT call /action]',
  '',
  'Your session transcript is getting long. Do the following to stay sharp:',
  '',
  '1. Summarize in 3–5 bullets what you\'ve learned about the user\'s play so far (leaks, strengths, recurring spots, villain reads). Keep it brief — this is compaction, not analysis.',
  '2. Re-Read `.claude/skills/coachbot/SKILL.md` AND `.claude/skills/poker-strategy/SKILL.md` to refresh: tool-tagging (⚙/📖), language routing, GTO analysis flow, tool/doc router.',
  '3. Reply with this line, nothing else:',
  '   refreshed',
  '',
  'Do NOT curl /action. Do NOT analyze the current hand. Just summarize → re-read → confirm.',
].join('\n');

// Queue a CoachBot call. Serialized against COACH_SID (same session can't
// take parallel --resume without corruption), but priority-aware:
//   - Default (priority=false): background auto-play asks from narrator —
//     pushed to the end, fire-and-forget, user doesn't miss them.
//   - priority=true: user typed into the chat input. Jumps the queue so
//     narrator's pending auto-asks don't make the user wait 30-60s to see
//     a reply. Still serialized against the currently-running claude -p
//     (can't preempt a running subprocess), but lands next.
// Optional `onEvent` callback turns on stream-json output so the caller sees
// events as they arrive (text_delta, tool_use, etc.). Resolves with the
// final assistant text (accumulated from text_delta events or result.result).
function runCoach(question, onEvent, priority = false) {
  return new Promise((resolve, reject) => {
    const item = { question, resolve, reject, onEvent };
    if (priority) coachQueue.unshift(item);
    else coachQueue.push(item);
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
  // Dedicated banner event so UI can show a persistent top strip during
  // maintenance (in addition to the one-off system chat line below).
  wsBroadcast({ type: 'coach-maintenance', on: true });
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
    wsBroadcast({ type: 'coach-maintenance', on: false });
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
  // Explicit list prevents CoachBot from curling `check` when a bet is
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
             + `\n★ LEGAL ACTIONS: ${legal.join(' | ')}${warn}`
             + `\n★ SUBMIT (only on explicit user instruction or in auto-play mode):`
             + `\n    curl -s -X POST localhost:3456/action -H 'Content-Type: application/json' -d '<payload>'`
             + `\n    Payloads: {"action":"fold"} | {"action":"check"} | {"action":"call"}`
             + `\n            | {"action":"bet","amount":N} | {"action":"raise","amount":N}   (N = TOTAL bet, not delta)`
             + `\n    Must match ★ LEGAL ACTIONS above. Don't narrate the curl.`;
  } else if (s.currentActor) {
    turnLine = `\nCurrent actor: ${s.currentActor} (NOT my turn — do NOT curl /action)`;
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

// Spawn claude with the given args. Returns { code, stdout, stderr }.
// Spawn `claude -p`. Two modes:
//   - Plain text (no onEvent): stdout is the final assistant message verbatim.
//     Used by init + maintenance paths.
//   - Streaming (onEvent provided): caller also appended
//     `--output-format stream-json --verbose --include-partial-messages` to
//     args. Each stdout line is one JSON event; onEvent fires per event so
//     the caller can forward text deltas / tool_use markers to the browser
//     in real time. The returned `assistantText` is the concatenated text
//     across all assistant content blocks (preferring result.result when it
//     arrives, which is the canonical final reply).
function spawnClaude(args, onEvent) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],  // no stdin — -p takes prompt as arg
    });
    let stdout = '', stderr = '', assistantText = '';
    let buf = '';
    proc.stdout.on('data', d => {
      const chunk = d.toString();
      stdout += chunk;
      if (!onEvent) return;
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        try { onEvent(evt); } catch (e) { /* swallow handler errors */ }
        // Accumulate assistant text for the return value.
        if (evt.type === 'stream_event'
            && evt.event && evt.event.type === 'content_block_delta'
            && evt.event.delta && evt.event.delta.type === 'text_delta') {
          assistantText += evt.event.delta.text || '';
        } else if (evt.type === 'result' && typeof evt.result === 'string') {
          // Final canonical reply — prefer it over delta-accumulated if longer.
          if (evt.result.length > assistantText.length) assistantText = evt.result;
        }
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => resolve({ code, stdout, stderr, assistantText }));
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
  const { question, resolve, reject, onEvent } = coachQueue.shift();

  try {
    const baseArgs = [
      // Model is read from coachbot/SKILL.md frontmatter at relay startup.
      // Single source of truth — change the `model:` field there only.
      '--model', COACH_MODEL,
      '--permission-mode', 'bypassPermissions',
    ];
    // Streaming mode requires these; init call below stays plain text.
    const streamArgs = onEvent
      ? ['--output-format', 'stream-json', '--verbose', '--include-partial-messages']
      : [];

    // Try --resume first. If session missing, initialize with --session-id + init prompt,
    // then retry the user question with --resume.
    let result = await spawnClaude(
      ['-p', question, '--resume', COACH_SID, ...baseArgs, ...streamArgs],
      onEvent
    );

    if (result.code !== 0 && isSessionMissing(result.stderr)) {
      log.info(`CoachBot session ${COACH_SID} not found — initializing...`);
      // Init is small + user doesn't need to see it streamed; plain mode.
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
      // Retry the actual question (re-streamed if caller asked for it).
      result = await spawnClaude(
        ['-p', question, '--resume', COACH_SID, ...baseArgs, ...streamArgs],
        onEvent
      );
    }

    if (result.code === 0) {
      coachSessionReady = true;
      // Streaming mode: stdout is NDJSON; use assistantText (accumulated from
      // text deltas / result event). Plain mode: stdout is the reply itself.
      resolve((onEvent ? result.assistantText : result.stdout).trim());
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
