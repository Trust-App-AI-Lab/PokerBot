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
const { spawn } = require('child_process');
const crypto = require('crypto');
const WebSocket = require('ws');
const {
  appendJsonl,
  handStartedEvent,
  playerActionEvent,
  streetDealtEvent,
  handEndedEvent,
  reconstructHands,
} = require('./lib/history-events');

// ── Parse CLI args ──────────────────────────────
// Name resolution order (so desktop launchers can work without hardcoded --name):
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
const CODEX_EVENTS_DIR = path.join(PROFILE_DIR, 'codex-events');
const COACH_CHAT_FILE = path.join(PROFILE_DIR, 'coach-chat.jsonl');
const TABLE_HTML   = path.join(__dirname, 'public', 'poker-table.html');
const COACH_SKILL_MD = path.join(PROJECT_ROOT, '.agents', 'skills', 'coachbot', 'SKILL.md');
const CODEX_AGENT = path.join(PROJECT_ROOT, 'scripts', 'codex-agent.js');
const NODE_BIN = process.execPath || process.env.NODE || 'node';

// Single source of truth for CoachBot's model: the frontmatter `model:`
// field in coachbot/SKILL.md. Both this relay and start-game.sh read the
// same file — change model there only. Falls back to 'gpt-5.4' if the file
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
  return 'gpt-5.4';
}
const COACH_MODEL = readCoachModel();

try {
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
  if (!fs.existsSync(CODEX_EVENTS_DIR)) fs.mkdirSync(CODEX_EVENTS_DIR, { recursive: true });
} catch (e) {
  console.error(`Failed to create data directories: ${e.message}`);
  process.exit(1);
}

// ── CoachBot logical session key mapped by scripts/codex-agent.js ──
const COACH_SESSION_KEY = `coachbot-${CONFIG.name}`;
// Stable browser cache key. The durable source is coach-chat.jsonl; tying this
// to process start time makes a relay restart look like a brand-new game and
// causes the UI to wipe already-hydrated CoachBot history.
const GAME_ID = COACH_SESSION_KEY;
const COACH_CODEX_FILE = path.join(CODEX_EVENTS_DIR, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${COACH_SESSION_KEY}.jsonl`);
const coachChatIds = new Set();
const coachChatKeys = new Set();

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
  // Rotate file after MAX_HANDS_PER_FILE hands (with guard)
  if (event.type === 'hand.started' || event.type === 'hand_start') {
    if (historyHandCount >= MAX_HANDS_PER_FILE && !_rotating) {
      _rotating = true;
      historyFile = path.join(HISTORY_DIR, new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.jsonl');
      historyHandCount = 0;
      _rotating = false;
    }
    historyHandCount++;
  }
  appendJsonl(historyFile, event, e => log.warn(`Failed to write history: ${e.message}`));
}

function logCoachCodexEvent(event, extra = {}) {
  if (!event || typeof event !== 'object') return;
  const record = {
    recorded_at: new Date().toISOString(),
    stream_schema: 'stuclaw.codex-stream.v1',
    source: 'coachbot',
    sessionKey: COACH_SESSION_KEY,
    ...extra,
    ...event,
  };
  try {
    fs.appendFileSync(COACH_CODEX_FILE, JSON.stringify(record) + '\n');
  } catch (e) {
    log.warn(`Failed to write CoachBot codex event: ${e.message}`);
  }
}

function loadCoachChatIds() {
  if (!fs.existsSync(COACH_CHAT_FILE)) return;
  try {
    const content = fs.readFileSync(COACH_CHAT_FILE, 'utf8').trim();
    if (!content) return;
    for (const line of content.split('\n')) {
      try {
        const rec = JSON.parse(line);
        if (rec && rec.id) coachChatIds.add(String(rec.id));
        const key = coachChatRecordKey(rec);
        if (key) coachChatKeys.add(key);
      } catch (_) { /* skip malformed legacy lines */ }
    }
  } catch (e) {
    log.warn(`Failed to read CoachBot chat ids: ${e.message}`);
  }
}

function compactCoachChatText(value, max = 1600) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function compactCoachChatCard(card) {
  if (!card || typeof card !== 'object') return null;
  const out = {
    id: String(card.id || crypto.randomUUID()),
    kind: String(card.kind || 'item'),
    title: compactCoachChatText(card.title || 'Step', 180),
  };
  if (card.detail) out.detail = compactCoachChatText(card.detail, 1200);
  if (card.body) out.body = compactCoachChatText(card.body, 1200);
  if (card.status) out.status = String(card.status);
  if (card.tone) out.tone = String(card.tone);
  if (Array.isArray(card.changes)) {
    out.changes = card.changes.slice(0, 12).map(change => ({
      path: String(change.path || ''),
      additions: Number(change.additions) || 0,
      deletions: Number(change.deletions) || 0,
    })).filter(change => change.path);
  }
  return out;
}

function normalizeCoachChatRecord(msg = {}) {
  const role = ['assistant', 'user', 'system', 'log'].includes(msg.role) ? msg.role : 'assistant';
  const id = String(msg.id || msg.sourceId || crypto.randomUUID());
  const record = {
    schema: 'pokerbot.coach-chat.v1',
    id,
    role,
    content: String(msg.content || ''),
    ts: msg.ts || new Date().toISOString(),
  };
  if (msg.logData && typeof msg.logData === 'object') record.logData = msg.logData;
  if (Array.isArray(msg.cards) && msg.cards.length) {
    record.cards = msg.cards.map(compactCoachChatCard).filter(Boolean).slice(-24);
  }
  if (msg.workedMs) record.workedMs = Number(msg.workedMs) || null;
  return record;
}

function coachChatRecordKey(record) {
  if (!record || typeof record !== 'object') return '';
  return [
    String(record.role || ''),
    String(record.ts || ''),
    String(record.content || '').slice(0, 1200),
    record.logData ? JSON.stringify(record.logData) : '',
    Array.isArray(record.cards) ? record.cards.map(card => card && card.id).filter(Boolean).join(',') : '',
  ].join('|');
}

function shouldSkipCoachChatRecord(record) {
  if (!record || record.role !== 'assistant') return false;
  return !String(record.content || '').trim()
    && !(Array.isArray(record.cards) && record.cards.length);
}

function appendCoachChatRecord(msg) {
  const record = normalizeCoachChatRecord(msg);
  if (shouldSkipCoachChatRecord(record)) return { ...record, skipped: true };
  const key = coachChatRecordKey(record);
  if (coachChatIds.has(record.id) || (key && coachChatKeys.has(key))) return { ...record, duplicate: true };
  try {
    fs.appendFileSync(COACH_CHAT_FILE, JSON.stringify(record) + '\n');
    coachChatIds.add(record.id);
    if (key) coachChatKeys.add(key);
  } catch (e) {
    log.warn(`Failed to write CoachBot chat history: ${e.message}`);
  }
  return record;
}

function persistAndBroadcastCoachMessage(msg) {
  const record = appendCoachChatRecord(msg);
  if (record.skipped) return record;
  const out = {
    ...msg,
    type: 'coach',
    id: record.id,
    role: record.role,
    content: record.content,
    ts: record.ts,
    persisted: true,
  };
  if (record.logData) out.logData = record.logData;
  if (record.cards) out.cards = record.cards;
  if (record.workedMs) out.workedMs = record.workedMs;
  wsBroadcast(out);
  return record;
}

function readCoachChatPage({ before, limit }) {
  const max = Math.max(1, Math.min(parseInt(limit || '120', 10) || 120, 240));
  if (!fs.existsSync(COACH_CHAT_FILE)) return { messages: [], hasMore: false };
  const beforeMs = before ? Date.parse(before) : Infinity;
  const records = [];
  const seenKeys = new Set();
  try {
    const content = fs.readFileSync(COACH_CHAT_FILE, 'utf8').trim();
    if (!content) return { messages: [], hasMore: false };
    for (const line of content.split('\n')) {
      try {
        const rec = JSON.parse(line);
        if (shouldSkipCoachChatRecord(rec)) continue;
        const key = coachChatRecordKey(rec);
        if (key && seenKeys.has(key)) continue;
        if (key) seenKeys.add(key);
        const tsMs = Date.parse(rec.ts || 0);
        if (!Number.isFinite(tsMs) || tsMs >= beforeMs) continue;
        records.push(rec);
      } catch (_) { /* skip malformed line */ }
    }
  } catch (e) {
    log.warn(`Failed to read CoachBot chat history: ${e.message}`);
    return { messages: [], hasMore: false };
  }
  records.sort((a, b) => {
    const at = Date.parse(a.ts || 0) || 0;
    const bt = Date.parse(b.ts || 0) || 0;
    if (at !== bt) return at - bt;
    const order = { system: 0, user: 1, assistant: 2, log: 3 };
    return (order[a.role] ?? 4) - (order[b.role] ?? 4);
  });
  const burstCounts = new Map();
  for (const rec of records) {
    if (rec.role !== 'log' || !rec.logData) continue;
    const key = `${rec.logData.hand ?? ''}|${String(rec.ts || '').slice(0, 19)}`;
    burstCounts.set(key, (burstCounts.get(key) || 0) + 1);
  }
  const filteredLogs = records.filter(rec => {
    if (rec.role !== 'log' || !rec.logData) return true;
    const burstKey = `${rec.logData.hand ?? ''}|${String(rec.ts || '').slice(0, 19)}`;
    if ((burstCounts.get(burstKey) || 0) >= 4) return false;
    return true;
  });
  const filtered = [];
  let lastSystemContent = '';
  for (const rec of filteredLogs) {
    if (rec.role === 'system') {
      const content = String(rec.content || '').trim();
      if (content && content === lastSystemContent) continue;
      lastSystemContent = content;
    } else if (rec.role === 'log' || rec.role === 'user') {
      lastSystemContent = '';
    }
    filtered.push(rec);
  }
  const hasMore = filtered.length > max;
  return { messages: filtered.slice(-max), hasMore };
}

loadCoachChatIds();

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
let loggedHandNum = 0;
let loggedActionHand = 0;
let loggedActionCount = 0;
let loggedBoardHand = 0;
let loggedBoardLength = 0;
const DEFAULT_TURN_TIMEOUT_MS = 180000;
let inferredTurnKey = '';
let inferredTurnDeadline = 0;

function stateTurnKey(state = currentState) {
  if (!state) return '';
  return `${state.handNumber || ''}|${state.phase || ''}|${state.currentActor || ''}|${state.callAmount || 0}|${(state.actions || []).length}`;
}

function isActionableHeroTurn(state = currentState) {
  if (!state || !state.isMyTurn || state.currentActor !== CONFIG.name) return false;
  return !['waiting', 'showdown', 'ended'].includes(state.phase);
}

function mergeLocalTurnDeadline(nextState, previousState = currentState) {
  if (!nextState || typeof nextState !== 'object') return nextState;
  const merged = { ...nextState };
  const turnKey = `${merged.handNumber || ''}|${merged.phase || ''}|${merged.currentActor || ''}|${(merged.actions || []).length}`;
  const incomingDeadline = Number(merged.turnDeadline || 0);
  if (incomingDeadline > Date.now()) {
    inferredTurnKey = turnKey;
    inferredTurnDeadline = incomingDeadline;
    return merged;
  }

  const previousDeadline = Number(previousState?.turnDeadline || 0);
  const isSameHeroTurn =
    previousDeadline > Date.now() &&
    merged.isMyTurn === true &&
    previousState?.isMyTurn === true &&
    merged.currentActor === CONFIG.name &&
    previousState?.currentActor === CONFIG.name &&
    merged.handNumber === previousState?.handNumber &&
    merged.phase === previousState?.phase;

  if (isSameHeroTurn) {
    merged.turnDeadline = previousDeadline;
    inferredTurnKey = turnKey;
    inferredTurnDeadline = previousDeadline;
  } else if (merged.isMyTurn === true && merged.currentActor === CONFIG.name) {
    if (inferredTurnKey === turnKey) {
      if (inferredTurnDeadline > Date.now()) merged.turnDeadline = inferredTurnDeadline;
    } else {
      inferredTurnKey = turnKey;
      inferredTurnDeadline = Date.now() + DEFAULT_TURN_TIMEOUT_MS;
      merged.turnDeadline = inferredTurnDeadline;
    }
  } else {
    inferredTurnKey = '';
    inferredTurnDeadline = 0;
    if ('turnDeadline' in merged) delete merged.turnDeadline;
  }
  return merged;
}

function playerSnapshotForHistory(state) {
  const players = {};
  for (const p of (state.players || [])) {
    if (p.name === CONFIG.name) {
      const cards = myCards.length ? [...myCards] : (Array.isArray(state.myCards) ? [...state.myCards] : []);
      players[p.name] = [cards, p.stack + (p.bet || 0)];
    } else {
      players[p.name] = [[], p.stack + (p.bet || 0)];
    }
  }
  return players;
}

function ensureHandLogged(state) {
  if (!state || !state.handNumber || loggedHandNum === state.handNumber) return;
  const cardsKnown = myCards.length || (Array.isArray(state.myCards) && state.myCards.length);
  if (!cardsKnown) return;
  loggedHandNum = state.handNumber;
  currentHandNum = state.handNumber;
  loggedActionHand = state.handNumber;
  loggedActionCount = 0;
  loggedBoardHand = state.handNumber;
  loggedBoardLength = 0;
  logEvent(handStartedEvent({
    hand: state.handNumber,
    blinds: [state.smallBlind, state.bigBlind],
    positions: state.positions || {},
    players: playerSnapshotForHistory(state),
  }));
}

function logNewActionsFromState(state) {
  if (!state || !state.handNumber || loggedHandNum !== state.handNumber) return;
  if (loggedActionHand !== state.handNumber) {
    loggedActionHand = state.handNumber;
    loggedActionCount = 0;
  }
  const actions = state.actions || [];
  for (const action of actions.slice(loggedActionCount)) {
    logEvent(playerActionEvent(state.handNumber, action, state.phase));
  }
  loggedActionCount = actions.length;
}

function logBoardFromState(state) {
  if (!state || !state.handNumber || loggedHandNum !== state.handNumber) return;
  const board = state.communityCards || state.board || [];
  if (!Array.isArray(board) || !board.length) return;
  if (loggedBoardHand !== state.handNumber) {
    loggedBoardHand = state.handNumber;
    loggedBoardLength = 0;
  }
  if (board.length <= loggedBoardLength) return;
  logEvent(streetDealtEvent({
    hand: state.handNumber,
    phase: state.phase,
    cards: board.slice(loggedBoardLength),
    board: [...board],
  }));
  loggedBoardLength = board.length;
}

function logStateProgress(state) {
  ensureHandLogged(state);
  logNewActionsFromState(state);
  logBoardFromState(state);
}

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

function upstreamPostJSON(pathStr, body) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(pathStr, CONFIG.serverUrl.replace(/^ws/, 'http'));
      const data = Buffer.from(JSON.stringify(body || {}));
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: 3000,
      }, res => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          let payload = null;
          try { payload = JSON.parse(buf || '{}'); } catch {}
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error((payload && payload.error) || buf || `upstream returned ${res.statusCode}`));
            return;
          }
          resolve(payload || {});
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.write(data);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function upstreamGetJSON(pathStr) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(pathStr, CONFIG.serverUrl.replace(/^ws/, 'http'));
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        timeout: 3000,
      }, res => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          let payload = null;
          try { payload = JSON.parse(buf || '{}'); } catch {}
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error((payload && payload.error) || buf || `upstream returned ${res.statusCode}`));
            return;
          }
          resolve(payload || {});
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function getJSONUrl(urlStr) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        timeout: 3000,
      }, res => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          let payload = null;
          try { payload = JSON.parse(buf || '{}'); } catch {}
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error((payload && payload.error) || buf || `request returned ${res.statusCode}`));
            return;
          }
          resolve(payload || {});
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function postJSONUrl(urlStr, body) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const data = Buffer.from(JSON.stringify(body || {}));
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: 3000,
      }, res => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          let payload = null;
          try { payload = JSON.parse(buf || '{}'); } catch {}
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error((payload && payload.error) || buf || `request returned ${res.statusCode}`));
            return;
          }
          resolve(payload || {});
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.write(data);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function setNarratorMode(mode) {
  return postJSONUrl('http://localhost:3460/mode', { mode });
}

function upstreamSendWS(payload) {
  if (upstream && upstream.readyState === WebSocket.OPEN) {
    upstream.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

async function refreshPlayerStateFromUpstream(reason = 'manual') {
  const fresh = await upstreamGetJSON(`/state?player=${encodeURIComponent(CONFIG.name)}`);
  if (!fresh || typeof fresh !== 'object') return false;

  const cards = Array.isArray(fresh.myCards) ? fresh.myCards : [];
  currentState = mergeLocalTurnDeadline(fresh, currentState);
  myCards = cards;
  currentState.myCards = cards;
  writeJSON(STATE_FILE, currentState);
  logStateProgress(currentState);
  wsBroadcast({ type: 'state', state: currentState });
  if (myCards.length > 0) wsBroadcast({ type: 'cards', cards: myCards });
  log.info(`Refreshed player state from upstream (${reason}): hand=${currentState.handNumber || '?'} phase=${currentState.phase || '?'} cards=${myCards.length ? myCards.join(' ') : 'none'}`);
  return true;
}

function parseCoachActionDirective(text) {
  const rawText = String(text || '');
  const lineMatch = rawText.match(/(?:^|\n)\s*ACTION_JSON\s*:\s*(\{[^\n]*\})\s*(?=\n|$)/i);
  const jsonText = lineMatch ? lineMatch[1] : (/^\s*\{[\s\S]*\}\s*$/.test(rawText) ? rawText.trim() : null);
  let action = null;
  if (jsonText) {
    try { action = JSON.parse(jsonText); } catch { action = null; }
  }
  const displayText = rawText
    .replace(/(?:^|\n)\s*ACTION_JSON\s*:\s*\{[^\n]*\}\s*(?=\n|$)/gi, '\n')
    .trim();
  return { action, displayText };
}

function createCoachVisibleStreamFilter() {
  let buffer = '';
  let suppressingActionLine = false;
  const actionPrefix = /(?:^|\n)[ \t]*ACTION_JSON[ \t]*:/i;
  const completeActionLine = /(?:^|\n)[ \t]*ACTION_JSON[ \t]*:\s*\{[^\n]*\}\s*(?=\n|$)/gi;
  const keepChars = 96;

  return {
    push(chunk) {
      if (!chunk) return '';
      buffer += String(chunk);

      if (suppressingActionLine) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) {
          buffer = buffer.slice(-2048);
          return '';
        }
        buffer = buffer.slice(newlineIndex + 1);
        suppressingActionLine = false;
      }

      const match = buffer.match(actionPrefix);
      if (match && typeof match.index === 'number') {
        const visible = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index);
        suppressingActionLine = true;
        return visible;
      }

      if (buffer.length <= keepChars) return '';
      const visible = buffer.slice(0, -keepChars);
      buffer = buffer.slice(-keepChars);
      return visible;
    },
    flush() {
      if (suppressingActionLine) {
        buffer = '';
        suppressingActionLine = false;
        return '';
      }
      const visible = buffer.replace(completeActionLine, '\n').trimEnd();
      buffer = '';
      return visible;
    },
  };
}

function normalizeCoachAction(action) {
  if (!action || typeof action !== 'object') throw new Error('missing action JSON object');
  const verb = String(action.action || '').toLowerCase();
  if (!['fold', 'check', 'call', 'bet', 'raise'].includes(verb)) {
    throw new Error(`unsupported action "${action.action}"`);
  }
  const payload = { action: verb };
  if (verb === 'bet' || verb === 'raise') {
    const amount = Number(action.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`${verb} requires a positive numeric amount`);
    }
    payload.amount = amount;
  }
  return payload;
}

async function submitCoachAction(action, expectedTurnKey = '') {
  const payload = normalizeCoachAction(action);
  if (!isActionableHeroTurn(currentState)) {
    throw new Error('not my turn');
  }
  if (expectedTurnKey && stateTurnKey(currentState) !== expectedTurnKey) {
    throw new Error('stale turn');
  }
  const result = await upstreamPostJSON('/action', {
    ...payload,
    player: CONFIG.name,
  });
  const amount = payload.amount ? ` $${payload.amount}` : '';
  log.info(`CoachBot action submitted: ${payload.action}${amount}`);
  return result;
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
        const hadState = !!currentState;
        const prevCount = hadState ? ((currentState.actions || []).length) : (((msg.state && msg.state.actions) || []).length);
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
            persistAndBroadcastCoachMessage({
              role: 'log',
              content: `Hand #${hn} · ${a.actor}${isMe ? ' (me)' : ''} ${verb}${amt}`,
              logData: { hand: hn, actor: a.actor, isMe, verb, amount: a.amount || 0 },
              ts: new Date().toISOString(),
            });
          }
        }
      }
      currentState = mergeLocalTurnDeadline(msg.state, currentState);
      if (currentState && myCards.length > 0) currentState.myCards = myCards;
      writeJSON(STATE_FILE, currentState);
      logStateProgress(currentState);
      break;

    case 'cards':
      myCards = msg.cards || [];
      log.info(`My cards: ${myCards.join(' ')}`);
      if (currentState) {
        currentState.myCards = myCards;
        writeJSON(STATE_FILE, currentState);
        logStateProgress(currentState);
      }
      break;

    case 'your_turn':
      log.info(`★ MY TURN! call=$${msg.callAmount}, pot=$${msg.pot}`);
      if (currentState) {
        currentState.isMyTurn = true;
        currentState.callAmount = msg.callAmount;
        currentState.minRaise = msg.minRaise;
        currentState.maxRaise = msg.maxRaise;
        currentState.currentActor = CONFIG.name;
        if (Number(msg.turnDeadline || 0) > Date.now()) {
          currentState.turnDeadline = msg.turnDeadline;
          inferredTurnKey = `${currentState.handNumber || ''}|${currentState.phase || ''}|${currentState.currentActor || ''}|${(currentState.actions || []).length}`;
          inferredTurnDeadline = msg.turnDeadline;
        } else {
          delete currentState.turnDeadline;
        }
        if (myCards.length > 0) currentState.myCards = myCards;
        writeJSON(STATE_FILE, currentState);
      }
      break;

    case 'hand_result': {
      const hn = msg.handNumber || currentHandNum;
      const resultStrs = (msg.results || []).map(r =>
        `${r.winner} ${r.amount}${r.hand ? ' ' + r.hand : ''}`
      );
      log.info(`RESULT: ${resultStrs.join(', ')}`);

      currentState = {
        ...(currentState || {}),
        handNumber: hn,
        phase: 'showdown',
        pot: msg.pot ?? currentState?.pot ?? 0,
        players: msg.players || currentState?.players || [],
        actions: msg.actions || currentState?.actions || [],
        communityCards: msg.board || currentState?.communityCards || [],
        board: msg.board || currentState?.board || [],
        currentActor: null,
        isMyTurn: false,
        callAmount: 0,
        minRaise: 0,
        maxRaise: 0,
        myCards: [],
      };
      myCards = [];
      writeJSON(STATE_FILE, currentState);
      logStateProgress(currentState);
      wsBroadcast({ type: 'state', state: currentState });

      // Write hand.ended — information-isolated
      const stacks = {};
      const shown = [];
      const shownCards = {};
      for (const p of (msg.players || [])) {
        stacks[p.name] = p.stack;
        if (p.cards && p.cards.length > 0 && !p.folded) {
          shown.push(p.name);
          shownCards[p.name] = [...p.cards];
        }
      }
      logEvent(handEndedEvent({
        hand: hn,
        results: resultStrs,
        payouts: msg.results || [],
        shown,
        shownCards,
        stacks,
        pot: msg.pot,
        board: msg.board || [],
      }));

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

  // GET /mode → proxy narrator mode to the browser so UI code stays same-origin.
  if (req.method === 'GET' && req.url === '/mode') {
    getJSONUrl('http://localhost:3460/mode')
      .then(payload => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      })
      .catch(e => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    return;
  }

  // POST /mode → structured narrator mode control. Keep it out of /coach-ask
  // so mode switches never depend on chat text and never enter chat history.
  if (req.method === 'POST' && req.url === '/mode') {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 1000) { req.destroy(); }
    });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const mode = payload.mode;
        if (mode !== 'auto' && mode !== 'manual') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'mode must be "auto" or "manual"' }));
          return;
        }
        const result = await setNarratorMode(mode);
        const nextMode = result.mode || mode;
        wsBroadcast({ type: 'coach-mode', mode: nextMode, ts: new Date().toISOString() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: nextMode }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // GET /coach-ui-history?limit=120&before=<iso>
  // Returns one oldest-to-newest page from the relay-side CoachBot chat log.
  // Browser localStorage is only a hot cache; this file is the durable source
  // for long single-session chats.
  if (req.method === 'GET' && (req.url === '/coach-ui-history' || req.url.startsWith('/coach-ui-history?'))) {
    try {
      const params = new URL(req.url, `http://localhost:${CONFIG.httpPort}`).searchParams;
      const page = readCoachChatPage({
        before: params.get('before') || '',
        limit: params.get('limit') || '120',
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...page }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // POST /coach-ui-history
  // The browser calls this after finalizing a rich streaming assistant bubble,
  // because only the browser has already converted JSONL stream items into UI
  // cards. Server-generated user/system messages are persisted before
  // broadcast and arrive with persisted=true, so the browser won't post them
  // back and create duplicates.
  if (req.method === 'POST' && req.url === '/coach-ui-history') {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 200000) { req.destroy(); }
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const record = appendCoachChatRecord(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: record }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
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

      // Reconstruct hands. Supports new structured events plus legacy
      // hand_start/action/board/hand_end JSONL.
      const hands = reconstructHands(events);
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

  // POST /action → submit this relay user's action to upstream server.
  // Use upstream HTTP instead of fire-and-forget WS so the browser gets a
  // real ok/error response and can refresh state immediately.
  if (req.method === 'POST' && req.url === '/action') {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 10000) { req.destroy(); }  // body size limit
    });
    req.on('end', async () => {
      try {
        const action = JSON.parse(body);
        const result = await upstreamPostJSON('/action', {
          ...action,
          player: action.player || CONFIG.name,
        });
        res.writeHead(result.ok === false ? 400 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
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
        const record = appendCoachChatRecord({
          id: payload.id || payload.sourceId,
          role: payload.role || 'assistant',
          content: payload.content,
          handNumber: payload.handNumber,
          phase: payload.phase,
          ts: payload.ts || new Date().toISOString(),
        });
        wsBroadcast({
          type: 'coach',
          id: record.id,
          role: payload.role || 'assistant',
          content: payload.content,
          handNumber: payload.handNumber,
          phase: payload.phase,
          ts: record.ts,
          persisted: true,
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
  //   question  — prompt sent to the mapped Codex CoachBot thread
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
      let question, silent = false, headline = null, allowAction = false, displayQuestion = null;
      try {
        const parsed = JSON.parse(body);
        question = parsed.question;
        silent = !!parsed.silent;
        headline = parsed.headline || null;
        allowAction = !!parsed.allowAction;
        displayQuestion = typeof parsed.displayQuestion === 'string' ? parsed.displayQuestion.trim() : null;
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
        const ts = new Date().toISOString();
        const record = appendCoachChatRecord({
          role: 'user',
          content: displayQuestion || question,
          ts,
        });
        wsBroadcast({
          type: 'coach',
          id: record.id,
          role: 'user',
          content: displayQuestion || question,
          ts,
          persisted: true,
        });
      } else if (headline) {
        const ts = new Date().toISOString();
        const record = appendCoachChatRecord({
          role: 'system',
          content: headline,
          ts,
        });
        wsBroadcast({
          type: 'coach',
          id: record.id,
          role: 'system',
          content: headline,
          ts,
          persisted: true,
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
        try {
          await refreshPlayerStateFromUpstream('coach-ask');
        } catch (e) {
          log.warn(`Could not refresh upstream state before CoachBot prompt: ${e.message}`);
        }

        // Prepend a fresh [CURRENT GAME STATE] block so the subprocess CoachBot
        // always reasons on live state, not its stale session memory (it only
        // auto-refreshes on `your_turn` / `hand_result` from narrator). Format
        // mirrors narrator.js stateSummary — bounded by delimiters so CoachBot
        // can distinguish the context block from the actual user question.
        const requestTurnKey = stateTurnKey(currentState);
        const cancelTurnKey = allowAction && isActionableHeroTurn(currentState) ? requestTurnKey : '';
        const actionAuth = allowAction
          ? '[ACTION AUTHORIZATION]\nThis user-facing chat request may submit an ACTION_JSON only if the latest user message explicitly asks you to execute, act, submit, or play the decision on their behalf, or if the request is from auto-play. If the user is only asking for advice or analysis, do not output ACTION_JSON.\n[/ACTION AUTHORIZATION]'
          : '[ACTION AUTHORIZATION]\nDo NOT output ACTION_JSON for this request. Give advice only.\n[/ACTION AUTHORIZATION]';
        const fullQuestion = buildStateBlock() + '\n\n' + actionAuth + '\n\n' + question;

        // Stream text deltas to the browser as they arrive so the user sees
        // the reasoning appear in real time. In auto-play mode, narrator sets
        // allowAction=true and the relay submits ACTION_JSON after streaming.
        const streamId = `coach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ts = new Date().toISOString();
        // NOTE: don't broadcast `coach-stream-start` at request time. If we fire it here
        // (at request time), every queued request creates an empty bubble
        // with a blinking cursor while it waits its turn — confusing when
        // multiple narrator+user asks pile up. Instead, onEvent opens it
        // lazily when the agent actually starts emitting JSONL events.
        let streamOpened = false;
        let sawTextDelta = false;
        const visibleStream = createCoachVisibleStreamFilter();
        let pendingCoachDelta = '';
        let coachDeltaTimer = null;
        let streamStartedAt = 0;
        const openStream = () => {
          if (streamOpened) return;
          streamOpened = true;
          streamStartedAt = Date.now();
          wsBroadcast({ type: 'coach-stream-start', id: streamId, role: 'assistant', ts });
        };
        const flushCoachDelta = () => {
          if (coachDeltaTimer) {
            clearTimeout(coachDeltaTimer);
            coachDeltaTimer = null;
          }
          if (!pendingCoachDelta) return;
          openStream();
          sawTextDelta = true;
          wsBroadcast({ type: 'coach-delta', id: streamId, text: pendingCoachDelta });
          pendingCoachDelta = '';
        };
        const queueCoachDelta = (text) => {
          if (!text) return;
          pendingCoachDelta += text;
          if (!coachDeltaTimer) coachDeltaTimer = setTimeout(flushCoachDelta, 80);
        };

        const onEvent = (evt) => {
          logCoachCodexEvent(evt, { streamId });
          if (evt && evt.type && evt.type !== 'stderr' && evt.type !== 'log') {
            openStream();
            wsBroadcast({ type: 'coach-stuclaw-event', id: streamId, event: evt });
          }
          if (evt.type === 'item.delta'
              && evt.item_type === 'agent_message'
              && typeof evt.delta === 'string') {
            const visibleDelta = visibleStream.push(evt.delta);
            if (visibleDelta) queueCoachDelta(visibleDelta);
            return;
          }
          if (evt.type !== 'item.completed' || !evt.item) return;
          if (evt.item.type === 'agent_message' && typeof evt.item.text === 'string') {
            if (!sawTextDelta) {
              const parsedText = parseCoachActionDirective(evt.item.text);
              const visibleText = parsedText.displayText || (parsedText.action ? '' : evt.item.text);
              visibleStream.flush();
              if (!visibleText) return;
              queueCoachDelta(visibleText);
              flushCoachDelta();
            }
          } else if (evt.item.type === 'command_execution') {
            flushCoachDelta();
          }
        };

        // Narrator auto-asks always come with `silent: true` (headline only,
        // no user message echo). A non-silent call means the user typed the
        // question — prioritize it so narrator's backlog of auto-turns
        // doesn't force the user to wait.
        const reply = await runCoach(fullQuestion, onEvent, !silent, { cancelTurnKey });
        if (!reply) {
          flushCoachDelta();
          if (streamOpened) {
            const workedMs = streamStartedAt ? Date.now() - streamStartedAt : null;
            wsBroadcast({ type: 'coach-stream-end', id: streamId, content: '', ts, workedMs });
          }
          wsBroadcast({ type: 'coach-thinking', on: false });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, content: '', canceled: true }));
          return;
        }
        const parsedReply = parseCoachActionDirective(reply);
        const displayReply = parsedReply.displayText || (parsedReply.action ? '' : reply);
        const trailingVisible = visibleStream.flush();
        if (trailingVisible) queueCoachDelta(trailingVisible);
        flushCoachDelta();
        // If the subprocess exited without ever streaming (no text, no
        // tool_use — e.g. empty reply), openStream never fired, so there's
        // no UI bubble to finalize. Skip the end event to avoid a dangling
        // stream-end targeting a non-existent bubble.
        if (streamOpened) {
          const workedMs = streamStartedAt ? Date.now() - streamStartedAt : null;
          wsBroadcast({ type: 'coach-stream-end', id: streamId, content: displayReply, ts, workedMs });
        }
        let actionResult = null;
        if (allowAction && parsedReply.action) {
          try {
            actionResult = await submitCoachAction(parsedReply.action, requestTurnKey);
          } catch (actionErr) {
            log.warn(`CoachBot action rejected: ${actionErr.message}`);
            wsBroadcast({
              type: 'coach',
              role: 'error',
              content: 'CoachBot action rejected: ' + actionErr.message,
              ts: new Date().toISOString(),
            });
          }
        } else if (parsedReply.action) {
          log.info('CoachBot action directive ignored because allowAction=false');
        }
        wsBroadcast({ type: 'coach-thinking', on: false });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          content: displayReply,
          actionSubmitted: !!(actionResult && actionResult.ok !== false),
          actionResult,
        }));
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
const clientRoles = new WeakMap();

wss.on('connection', (clientWs, req) => {
  let role = 'browser';
  try {
    const url = new URL(req.url || '/', `http://localhost:${CONFIG.httpPort}`);
    role = url.searchParams.get('client') === 'narrator' ? 'automation' : 'browser';
  } catch {}
  clientRoles.set(clientWs, role);
  browserClients.add(clientWs);
  log.info(`${role === 'automation' ? 'Automation' : 'Browser'} connected (${browserClients.size} total)`);

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
  if (role === 'browser') {
    try {
      const page = readCoachChatPage({ before: '', limit: '120' });
      for (const record of page.messages) {
        wsSend(clientWs, 'coach', {
          id: record.id,
          role: record.role,
          content: record.content,
          ts: record.ts,
          logData: record.logData,
          cards: record.cards,
          workedMs: record.workedMs,
          persisted: true,
        });
      }
    } catch (e) {
      log.warn(`Failed to hydrate browser CoachBot history: ${e.message}`);
    }
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
      } else if (msg.type === 'action') {
        upstreamPostJSON('/action', {
          player: CONFIG.name,
          action: msg.action,
          amount: msg.amount,
        }).catch(err => {
          wsSend(clientWs, 'error', { message: err.message });
        });
      } else if (msg.type === 'start') {
        // Browser's "Start" button (host deals the next hand). Upstream
        // exposes this as HTTP POST /start — forward over a small local
        // request. Non-blocking, fire-and-forget.
        upstreamPost('/start', {});
      } else if (msg.type === 'settings') {
        // Browser's settings panel Apply → upstream WS `settings`.
        // HTTP /config does not carry autoStart, but the engine's WS command
        // does, so keep table settings on the same control path as pause/rebuy.
        if (!upstreamSendWS({
          type: 'settings',
          smallBlind: msg.smallBlind,
          bigBlind:   msg.bigBlind,
          autoStart:  msg.autoStart,
        })) {
          wsSend(clientWs, 'error', { message: 'Server disconnected' });
        }
      } else if (['sit_out', 'sit_back', 'leave', 'rebuy', 'pause', 'resume', 'kick'].includes(msg.type)) {
        const payload = { type: msg.type };
        if (msg.amount !== undefined) payload.amount = msg.amount;
        if (msg.seat !== undefined) payload.seat = msg.seat;
        if (msg.name !== undefined) payload.name = msg.name;
        if (!upstreamSendWS(payload)) {
          wsSend(clientWs, 'error', { message: 'Server disconnected' });
          return;
        }
        if (msg.type === 'leave') joined = false;
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
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (clientRoles.get(ws) === 'automation' && !isAutomationBroadcast(msg)) continue;
    ws.send(raw);
  }
}

function isAutomationBroadcast(msg) {
  return msg && [
    'state',
    'cards',
    'your_turn',
    'hand_result',
    'error',
    'joined',
    'welcome',
  ].includes(msg.type);
}

// ══════════════════════════════════════════════════
// COACHBOT — serialized Codex agent calls against COACH_SESSION_KEY
// ══════════════════════════════════════════════════
// One subprocess at a time: concurrent resume against the same mapped thread
// can interleave context. FIFO queue guarantees serialization.
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
  'Read .agents/skills/coachbot/SKILL.md and follow it throughout this session. ' +
  'Also Read .agents/skills/poker-strategy/SKILL.md — tiny router (tools + doc index). ' +
  'Do NOT bulk-load the strategy docs; per-turn Read individual docs on-demand when the spot calls for them. ' +
  'Important: CoachBot replies must include visible public reasoning in the final answer; hidden reasoning is not user-facing. ' +
  'When ready, wait for the user\'s next message.';

// ── Periodic session maintenance ──────────────────────────────
// Long sessions drift: the transcript grows, Codex may compact early
// turns (dropping the SKILL.md tool-result we seeded at init), and we start
// seeing symptoms — forgotten legal-action rules, skipped ACTION_JSON output,
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
// compared to the old 15. The maintenance turn is usually short enough
// to not matter much when it does hit.
const COMPACT_INTERVAL = parseInt(process.env.COACH_COMPACT_INTERVAL || '30', 10);
const MAINTENANCE_PROMPT = [
  '[SESSION MAINTENANCE — no user question this turn, do NOT call /action]',
  '',
  'Your session transcript is getting long. Do the following to stay sharp:',
  '',
  '1. Summarize in 3–5 bullets what you\'ve learned about the user\'s play so far (leaks, strengths, recurring spots, villain reads). Keep it brief — this is compaction, not analysis.',
  '2. Re-Read `.agents/skills/coachbot/SKILL.md` AND `.agents/skills/poker-strategy/SKILL.md` to refresh: tool-tagging (⚙/📖), language routing, GTO analysis flow, tool/doc router.',
  '   Pay special attention to the Visible Reasoning Contract: real CoachBot replies must put public coaching logic in visible text.',
  '3. Reply with this line, nothing else:',
  '   refreshed',
  '',
  'Do NOT output ACTION_JSON. Do NOT analyze the current hand. Just summarize → re-read → confirm.',
].join('\n');

// Queue a CoachBot call. Serialized against COACH_SESSION_KEY (same mapped
// thread should not take parallel resumes), but priority-aware:
//   - Default (priority=false): background auto-play asks from narrator —
//     pushed to the end, fire-and-forget, user doesn't miss them.
//   - priority=true: user typed into the chat input. Jumps the queue so
//     narrator's pending auto-asks don't make the user wait 30-60s to see
//     a reply. Still serialized against the currently-running agent call
//     (can't preempt a running subprocess), but lands next.
// Optional `onEvent` callback turns on stream-json output so the caller sees
// events as they arrive (text_delta, tool_use, etc.). Resolves with the
// final assistant text (accumulated from text_delta events or result.result).
function runCoach(question, onEvent, priority = false, options = {}) {
  return new Promise((resolve, reject) => {
    const item = { question, resolve, reject, onEvent, cancelTurnKey: options.cancelTurnKey || '' };
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
  persistAndBroadcastCoachMessage({
    role: 'system',
    content: `CoachBot maintenance running (${coachInvocationCount}/${COMPACT_INTERVAL})`,
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
    persistAndBroadcastCoachMessage({
      role: 'system',
      content: 'CoachBot refreshed',
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
      content: `CoachBot maintenance failed: ${e.message}`,
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
  // Explicit list prevents CoachBot from selecting `check` when a bet is
  // outstanding (previous bug: "Must call $100 or fold" rejections).
  let turnLine;
  const actionableTurn = s.isMyTurn && !['waiting', 'showdown', 'ended'].includes(s.phase);
  if (actionableTurn) {
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
             + `\n★ ACTION OUTPUT (only on explicit user instruction or in auto-play mode):`
             + `\n    Do NOT call curl or /action yourself. Finish the coaching text, then put one final line:`
             + `\n    ACTION_JSON: {"action":"fold"} | ACTION_JSON: {"action":"check"} | ACTION_JSON: {"action":"call"}`
             + `\n               | ACTION_JSON: {"action":"bet","amount":N} | ACTION_JSON: {"action":"raise","amount":N}`
             + `\n    N = TOTAL bet, not delta. Must match ★ LEGAL ACTIONS above.`;
  } else if (s.currentActor) {
    turnLine = `\nCurrent actor: ${s.currentActor} (NOT my turn — do NOT output ACTION_JSON)`;
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

function spawnCodexAgent(prompt, { resume = true, json = false, onEvent = null, cancelTurnKey = '' } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      CODEX_AGENT,
      '--session-key', COACH_SESSION_KEY,
      '--model', COACH_MODEL,
    ];
    if (resume) args.push('--resume');
    if (json || onEvent) args.push('--json');
    args.push(prompt);

    const proc = spawn(NODE_BIN, args, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let canceled = false;
    const cancelWatcher = cancelTurnKey ? setInterval(() => {
      if (!isActionableHeroTurn(currentState) || stateTurnKey(currentState) !== cancelTurnKey) {
        canceled = true;
        log.warn('CoachBot turn changed while thinking — canceling stale agent');
        try { proc.kill('SIGTERM'); } catch {}
      }
    }, 1000) : null;
    let stdout = '', stderr = '', assistantText = '';
    let buf = '';
    proc.stdout.on('data', d => {
      const chunk = d.toString();
      stdout += chunk;
      if (!json && !onEvent) return;
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (onEvent) {
          try { onEvent(evt); } catch { /* swallow handler errors */ }
        }
        if (evt.type === 'item.completed'
            && evt.item
            && evt.item.type === 'agent_message'
            && typeof evt.item.text === 'string') {
          assistantText = evt.item.text;
        }
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (cancelWatcher) clearInterval(cancelWatcher);
      resolve({ code, stdout, stderr, assistantText, canceled });
    });
    proc.on('error', err => {
      if (cancelWatcher) clearInterval(cancelWatcher);
      reject(err);
    });
  });
}

async function drainCoachQueue() {
  if (coachBusy || coachQueue.length === 0) return;
  coachBusy = true;
  const { question, resolve, reject, onEvent, cancelTurnKey } = coachQueue.shift();

  try {
    if (cancelTurnKey && (!isActionableHeroTurn(currentState) || stateTurnKey(currentState) !== cancelTurnKey)) {
      log.warn('CoachBot queued request became stale before it started — skipping');
      resolve('');
      return;
    }
    if (!coachSessionReady) {
      log.info(`CoachBot session ${COACH_SESSION_KEY} initializing/refreshed...`);
      const init = await spawnCodexAgent(COACH_INIT_PROMPT, { resume: true });
      if (init.code !== 0) {
        throw new Error('CoachBot init failed: ' + (init.stderr.trim() || `exit ${init.code}`));
      }
      log.info('✓ CoachBot session initialized');
      coachSessionReady = true;
    }

    const result = await spawnCodexAgent(question, {
      resume: true,
      json: !!onEvent,
      onEvent,
      cancelTurnKey,
    });

    if (result.canceled) {
      resolve('');
    } else if (result.code === 0) {
      coachSessionReady = true;
      resolve((onEvent ? result.assistantText : result.stdout).trim());
    } else {
      reject(new Error(result.stderr.trim() || `Codex agent exited ${result.code}`));
    }
  } catch (err) {
    reject(err);
  } finally {
    coachBusy = false;
    drainCoachQueue();
  }
}

// ── Start ───────────────────────────────────────
httpServer.listen(CONFIG.httpPort, '127.0.0.1', () => {
  log.info(`Local UI: http://localhost:${CONFIG.httpPort}`);
  log.info(`History:  ${historyFile}`);
  log.info(`CoachBot: ${COACH_SESSION_KEY}`);
  connectUpstream();
});

// ── Graceful shutdown ───────────────────────────
process.on('SIGINT', () => {
  log.info('Shutting down...');
  if (upstream) upstream.close();
  httpServer.close();
  process.exit(0);
});
