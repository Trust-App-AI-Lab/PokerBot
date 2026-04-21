#!/usr/bin/env node
/**
 * narrator.js — Event-driven CoachBot trigger + optional auto-play.
 *
 * Subscribes to the relay's WebSocket (localhost:3456 by default, same stream
 * the browser sees), and reacts to game events in real time:
 *   - your_turn   → ask CoachBot to analyze (manual) or decide (auto-play)
 *   - hand_result → ask CoachBot for a short post-hand review
 *
 * Replaces the old CronCreate polling loop. No 10s polls, no CC involvement
 * for per-turn coaching — the narrator runs as its own daemon.
 *
 * Mode control:
 *   - Defaults to "manual" (coach comments, user acts).
 *   - Switch at runtime:  curl -X POST localhost:3460/mode -d '{"mode":"auto"}'
 *   - Check:              curl localhost:3460/mode
 *
 * Usage:
 *   node narrator.js [--relay http://localhost:3456] [--port 3460] [--lang zh|en]
 *
 * Relay endpoints used:
 *   GET  /state                                          — current game state
 *   POST /coach-ask  { question, silent, headline }       — run CoachBot
 *   POST /action     { action, amount }                   — execute a move
 *   WS   ws://<relay>                                     — live event stream
 */

const http = require('http');
const { URL } = require('url');
const WebSocket = require('ws');

// ── Args ─────────────────────────────────────────
function parseArgs() {
  const a = process.argv.slice(2);
  const cfg = {
    relay: 'http://localhost:3456',
    port: 3460,
    lang: 'zh',  // default; auto-detected from CoachBot replies if needed
    mode: 'manual',
  };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--relay' && a[i + 1]) cfg.relay = a[++i];
    else if (a[i] === '--port' && a[i + 1]) cfg.port = parseInt(a[++i], 10);
    else if (a[i] === '--lang' && a[i + 1]) cfg.lang = a[++i];
    else if (a[i] === '--auto') cfg.mode = 'auto';
  }
  return cfg;
}

const CFG = parseArgs();
const RELAY_HTTP = CFG.relay.replace(/\/$/, '');
const RELAY_WS   = RELAY_HTTP.replace(/^http/, 'ws');

const log = {
  info: (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] narrator`, ...a),
  warn: (...a) => console.warn(`[${new Date().toISOString().slice(11, 19)}] narrator ⚠`, ...a),
};

// ── State ────────────────────────────────────────
let mode = CFG.mode;         // 'manual' | 'auto'
let myName = null;           // learned from 'welcome' or 'joined'
let myCards = [];
let currentState = null;
let lastHandNum = 0;
let lastTurnKey = null;      // dedupe trigger per (hand, phase, bet)
let lastResultHand = 0;      // dedupe hand_result trigger
let coachBusy = false;       // don't stack requests — relay already queues, but we skip new turn prompts while one is pending

// ── Retry state for rejected auto-play actions ───
// When upstream rejects the coach's sentinel action (e.g. "Must call $60 or fold"),
// the server keeps the turn on us but emits no new your_turn event. Without a
// retry path narrator's dedupe (lastTurnKey) pins the turn shut and we time out.
// So: on an action-rejection error, stash the reason, null lastTurnKey, and
// re-fire handleYourTurn so the coach gets another shot with the reason attached.
let lastRejection = null;
let retryCountForKey = 0;
let retryTrackingKey = null;
const MAX_ACTION_RETRIES = 2;

// ── Relay HTTP helpers ───────────────────────────
function relayPost(pathStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathStr, RELAY_HTTP);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { resolve({ raw: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Prompts ──────────────────────────────────────
function langTag() { return CFG.lang === 'en' ? '[English]' : '[中文]'; }

function stateSummary() {
  if (!currentState) return '(no state)';
  const s = currentState;
  const players = (s.players || []).map(p => {
    const tag = p.name === myName ? '(me)' : '';
    return `${p.name}${tag} seat=${p.seat} stack=$${p.stack} bet=$${p.bet || 0}${p.folded ? ' FOLDED' : ''}${p.allIn ? ' ALL-IN' : ''}`;
  }).join(' | ');
  const board = (s.board || []).join(' ') || '(no board)';
  const pot = s.pot || 0;
  const positions = s.positions ? JSON.stringify(s.positions) : '{}';
  const recent = (s.recentActions || []).slice(-8).map(a =>
    `${a.actor} ${a.action}${a.amount ? ' ' + a.amount : ''}`
  ).join(' → ');
  const cards = myCards.length ? myCards.join(' ') : '(hidden)';
  return [
    `Hand #${s.handNumber || '?'} phase=${s.phase}`,
    `My cards: ${cards}`,
    `Board: ${board}`,
    `Pot: $${pot}`,
    `Positions: ${positions}`,
    `Players: ${players}`,
    `Recent: ${recent || '(none)'}`,
    s.isMyTurn ? `★ MY TURN — callAmount=$${s.callAmount || 0} minRaise=$${s.minRaise || 0} maxRaise=$${s.maxRaise || 0}` : '',
  ].filter(Boolean).join('\n');
}

// NOTE: we no longer embed stateSummary() in the prompt — the relay
// (poker-client.js /coach-ask) auto-prepends a fresh [CURRENT GAME STATE]
// block to every question. Narrator just supplies the trigger reason.
function buildTurnPrompt() {
  const head = langTag() + (mode === 'auto' ? ' Auto-play.' : ' Manual.');
  const tail = mode === 'auto'
    ? '\n\nIMPORTANT: Your LAST line must be EXACTLY:\nACTION=<fold|check|call|raise> AMOUNT=<integer>\n(AMOUNT is the total raise-to value for "raise", otherwise 0.)'
    : '';
  let rej = '';
  if (lastRejection) {
    rej = `\n\n⚠ Your PREVIOUS action on this turn was REJECTED by the server: "${lastRejection}".\nRead the state block above carefully (callAmount / legal moves) and pick a LEGAL action this time.`;
    lastRejection = null;  // consume — only feed once per retry
  }
  return `${head} It is my turn. Analyze the state block above and coach me.${rej}${tail}`;
}

function buildReviewPrompt(handNum) {
  return `${langTag()} Hand #${handNum} just ended. Using the state block above (final stacks, action log, board), give a brief post-hand review (2-4 short lines).`;
}

function turnHeadline() {
  const s = currentState || {};
  if (CFG.lang === 'en') {
    return s.callAmount > 0
      ? `★ Your turn — call $${s.callAmount} / raise / fold?`
      : `★ Your turn — check or bet?`;
  }
  return s.callAmount > 0
    ? `★ 轮到你了 — call $${s.callAmount} / raise / fold？`
    : `★ 轮到你了 — check 还是 bet？`;
}

function reviewHeadline(handNum) {
  return CFG.lang === 'en' ? `Hand #${handNum} review` : `第 ${handNum} 手复盘`;
}

// ── Core event handlers ──────────────────────────
async function handleYourTurn() {
  if (!currentState || !currentState.isMyTurn) return;
  // Dedupe: same hand + phase + callAmount → skip
  const key = `${currentState.handNumber}:${currentState.phase}:${currentState.callAmount || 0}:${(currentState.recentActions || []).length}`;
  if (key === lastTurnKey) return;
  lastTurnKey = key;

  if (coachBusy) {
    log.info('skip your_turn — coach busy');
    return;
  }
  coachBusy = true;
  const prompt = buildTurnPrompt();
  log.info(`trigger coach (your_turn, ${mode}, hand #${currentState.handNumber})`);
  try {
    // In auto mode the prompt (see buildTurnPrompt) instructs the subprocess
    // to emit `ACTION=<op> AMOUNT=<N>` on its last line. The relay parses
    // that sentinel, strips it from the broadcast, and forwards the action
    // upstream — narrator just needs to verify it happened via r.action.
    const r = await relayPost('/coach-ask', {
      question: prompt,
      silent: true,
      headline: turnHeadline(),
    });
    if (!r.ok) { log.warn('coach-ask failed:', r.error); return; }
    if (mode === 'auto') {
      if (r.action) {
        log.info(`auto-play → ${r.action.action}${r.action.amount != null ? ' ' + r.action.amount : ''} (forwarded by relay)`);
      } else {
        log.warn('auto-play: no ACTION= sentinel in reply — nothing forwarded');
      }
    }
  } catch (e) {
    log.warn('your_turn error:', e.message);
  } finally {
    coachBusy = false;
  }
}

// Upstream rejected something we sent. The most common case is an illegal
// auto-play action ("Must call $60 or fold"). When we detect that, stash the
// reason + null lastTurnKey so buildTurnPrompt picks up the rejection note and
// handleYourTurn re-fires. Non-action errors (e.g. "Name taken") are ignored
// — relay handles its own reconnect logic.
function handleUpstreamError(raw) {
  if (!raw) return;
  const low = raw.toLowerCase();
  // Heuristic: engine rejection strings mention the action verbs / modal "must".
  const isActionReject =
    /\b(must|illegal|invalid|cannot|can't|not your turn|no such action|below min|exceeds max)\b/.test(low) ||
    /\b(fold|check|call|raise|bet)\b/.test(low);
  if (!isActionReject) return;

  if (mode !== 'auto') {
    // Manual: user issued the command; don't retry autonomously. Just log.
    log.warn(`upstream rejected (manual mode, not retrying): ${raw}`);
    return;
  }

  // Retry budget per turn — if the coach keeps picking illegal moves, give up
  // rather than spin claude -p forever. The server's turn timeout will handle it.
  const key = lastTurnKey || '?';
  if (retryTrackingKey !== key) { retryTrackingKey = key; retryCountForKey = 0; }
  retryCountForKey++;
  if (retryCountForKey > MAX_ACTION_RETRIES) {
    log.warn(`giving up after ${retryCountForKey} rejections on turn ${key} — last: ${raw}`);
    lastRejection = null;
    return;
  }

  lastRejection = raw;
  log.warn(`upstream rejected action: "${raw}" — retry ${retryCountForKey}/${MAX_ACTION_RETRIES}`);
  lastTurnKey = null;  // unlock dedupe so handleYourTurn can fire again
  if (currentState && currentState.isMyTurn && !coachBusy) {
    handleYourTurn();
  }
  // If coachBusy is true, the in-flight coach will finish and return; by then
  // the upstream rejection is already stashed via lastRejection. Next natural
  // state broadcast will re-trigger via the state case. Worst case: we rely
  // on a re-broadcast. If that doesn't come, the timeout kicks in — safe.
}

async function handleHandResult(handNum) {
  if (handNum === lastResultHand) return;
  lastResultHand = handNum;
  log.info(`trigger coach (hand_result, #${handNum})`);
  try {
    await relayPost('/coach-ask', {
      question: buildReviewPrompt(handNum),
      silent: true,
      headline: reviewHeadline(handNum),
    });
  } catch (e) {
    log.warn('hand_result error:', e.message);
  }
}

// ── WS client → relay (same stream browser gets) ──
let ws = null;
let reconnectTimer = null;

function connect() {
  log.info(`connecting to ${RELAY_WS}...`);
  try { ws = new WebSocket(RELAY_WS); }
  catch (e) { log.warn('connect failed:', e.message); scheduleReconnect(); return; }

  ws.on('open', () => {
    log.info('connected to relay');
    // We're an observer; relay auto-sends welcome + state on connect.
  });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case 'welcome':
        if (msg.autoJoinName) myName = msg.autoJoinName;
        break;
      case 'joined':
        if (msg.name) myName = msg.name;
        break;
      case 'state':
        currentState = msg.state;
        if (currentState && currentState.isMyTurn) {
          handleYourTurn();
        }
        break;
      case 'cards':
        myCards = msg.cards || [];
        break;
      case 'your_turn':
        // Merge fields into currentState and trigger
        if (currentState) {
          currentState.isMyTurn = true;
          currentState.callAmount = msg.callAmount;
          currentState.minRaise = msg.minRaise;
          currentState.maxRaise = msg.maxRaise;
        }
        handleYourTurn();
        break;
      case 'hand_result':
        handleHandResult(msg.handNumber || lastHandNum);
        break;
      case 'error':
        handleUpstreamError(msg.message || '');
        break;
    }
    if (currentState && currentState.handNumber && currentState.handNumber !== lastHandNum) {
      lastHandNum = currentState.handNumber;
    }
  });

  ws.on('close', () => { log.warn('disconnected'); scheduleReconnect(); });
  ws.on('error', () => {});
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
}

// ── Tiny HTTP for mode control ───────────────────
const ctrl = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/mode') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mode, lang: CFG.lang, relay: RELAY_HTTP }));
    return;
  }
  if (req.method === 'POST' && req.url === '/mode') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1000) req.destroy(); });
    req.on('end', () => {
      try {
        const p = JSON.parse(body || '{}');
        if (p.mode === 'auto' || p.mode === 'manual') {
          mode = p.mode;
          log.info(`mode → ${mode}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mode }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'mode must be "auto" or "manual"' }));
        }
        if (p.lang === 'zh' || p.lang === 'en') CFG.lang = p.lang;
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

ctrl.listen(CFG.port, () => {
  log.info(`control API on :${CFG.port} (mode=${mode}, lang=${CFG.lang})`);
  connect();
});

process.on('SIGINT', () => {
  log.info('shutting down');
  if (ws) ws.close();
  ctrl.close();
  process.exit(0);
});
