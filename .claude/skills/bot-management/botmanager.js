#!/usr/bin/env node
/**
 * botmanager.js — Event-driven bot decision executor.
 *
 * Subscribes to the server WS at :3457 as an unjoined observer. When the
 * server broadcasts a global 'turn' event (added in poker-server.js alongside
 * the per-player 'your_turn'), we check if the actor is a known bot under
 * .claude/skills/bot-management/bots/<name>/personality.md. If so, we:
 *   1. GET /state?player=<name>   — the bot's info-isolated view (hole cards)
 *   2. Build turn prompt          = botmanager-turn.md + personality body + env + state JSON
 *   3. Spawn `claude -p`          with --session-id (first turn) or --resume
 *
 * Replaces the 2-second polling loop in botmanager.sh. Zero wasted curls
 * between turns; cache-warm static prefix (turn.md + body) + dynamic state
 * suffix per turn.
 *
 * CoachBot is excluded — it has its own trigger path (narrator → /coach-ask).
 *
 * Usage:
 *   node botmanager.js [--server http://localhost:3457] [--bots "A,B"] [--verbose]
 *
 * File mode (pokernow fallback) still lives in botmanager.sh.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { spawn } = require('child_process');

// `ws` is installed under poker-server/node_modules by start-server.sh. We
// don't duplicate the install for bot-management — resolve it from there.
const WebSocket = require(require.resolve('ws', {
  paths: [path.join(__dirname, '..', 'poker-server', 'node_modules')],
}));

// ── Paths ─────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const BOTS_DIR = path.join(__dirname, 'bots');
const PROMPT_TURN = path.join(__dirname, 'botmanager-turn.md');
const PID_FILE = path.join(__dirname, '.botmanager.pid');
const LOG_FILE = path.join(__dirname, '.botmanager.log');

// Optional binary pins (paths.env)
const PATHS_ENV = path.join(PROJECT_ROOT, 'paths.env');
const envPins = {};
if (fs.existsSync(PATHS_ENV)) {
  for (const line of fs.readFileSync(PATHS_ENV, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)=(.*?)\s*$/);
    if (m) envPins[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ── Args ──────────────────────────────────────────
function parseArgs() {
  const a = process.argv.slice(2);
  const cfg = { server: 'http://localhost:3457', bots: '', verbose: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--server' && a[i + 1]) cfg.server = a[++i];
    else if (a[i] === '--bots' && a[i + 1]) cfg.bots = a[++i];
    else if (a[i] === '--verbose') cfg.verbose = true;
  }
  return cfg;
}

const CFG = parseArgs();
const SERVER_HTTP = CFG.server.replace(/\/$/, '');
const SERVER_WS = SERVER_HTTP.replace(/^http/, 'ws');
const BOT_ALLOW = CFG.bots ? CFG.bots.split(',').map(s => s.trim()).filter(Boolean) : null;

// ── Claude CLI + python resolution ───────────────
function resolveClaude() {
  if (envPins.CLAUDE_BIN && fs.existsSync(envPins.CLAUDE_BIN)) return envPins.CLAUDE_BIN;
  for (const p of [path.join(process.env.HOME || '', '.local/bin/claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']) {
    if (fs.existsSync(p)) return p;
  }
  return 'claude';
}
const CLAUDE_BIN = resolveClaude();

// ── Logging ───────────────────────────────────────
const ts = () => new Date().toISOString().slice(11, 19);
const log = {
  info: (...a) => console.log(`[${ts()}] BotManager`, ...a),
  warn: (...a) => console.warn(`[${ts()}] BotManager ⚠`, ...a),
  debug: (...a) => { if (CFG.verbose) console.log(`[${ts()}] BotManager [DEBUG]`, ...a); },
};

// ── State ─────────────────────────────────────────
// BOT_SESSIONS: once a bot has had its first --session-id turn, subsequent
// turns use --resume so in-game observations (previous hands, opponent reads)
// carry forward. Full turn prompt re-injected every turn — memory drift over
// a long session can't erode what's re-stated each turn.
const BOT_SESSIONS = new Set();
// In-flight per bot — the engine's action_required may re-fire if we don't
// beat the server's turn timeout; dedupe so we don't stack claude -p invocations.
const INFLIGHT = new Set();

// Per-bot hand tracking for periodic session clear. Long sessions drift past
// the 5-minute prompt-cache TTL; every RESET_AFTER_HANDS hands we
//   1) run a maintenance turn on the old session that captures a short bullet
//      summary of what the bot observed (saved into BOT_MEMORY),
//   2) rotate the SID by bumping BOT_EPOCHS[bot] → next turn uses --session-id
//      on a brand-new UUID, abandoning the old session entirely,
//   3) inject the saved summary as a "## Carryover" block into the fresh
//      session's first turn prompt so key observations aren't lost.
//
// Triggers ONLY at hand boundaries (new handNumber seen), never mid-hand.
// Per-bot counters so bots that sit out hands count by hands-actually-played.
const BOT_LAST_HAND = new Map();         // bot -> last handNumber we saw
const BOT_HANDS_SINCE_RESET = new Map(); // bot -> hands since last reset
const BOT_EPOCHS = new Map();            // bot -> SID epoch (increments each reset)
const BOT_MEMORY = new Map();            // bot -> carryover summary text
const RESET_AFTER_HANDS = 10;

// ── Helpers ───────────────────────────────────────
function readPersonality(bot) {
  const p = path.join(BOTS_DIR, bot, 'personality.md');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function isKnownBot(name) {
  if (!name) return false;
  if (name === 'CoachBot') return false;
  if (BOT_ALLOW && !BOT_ALLOW.includes(name)) return false;
  return fs.existsSync(path.join(BOTS_DIR, name, 'personality.md'));
}

function parsePersonality(bot) {
  const raw = readPersonality(bot);
  if (!raw) return null;
  // Split on first two --- fences: frontmatter then body.
  const lines = raw.split('\n');
  let fm = 0;
  let fmStart = -1, fmEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      fm++;
      if (fm === 1) fmStart = i;
      else if (fm === 2) { fmEnd = i; break; }
    }
  }
  let model = '';
  if (fmStart !== -1 && fmEnd !== -1) {
    for (let i = fmStart + 1; i < fmEnd; i++) {
      const m = lines[i].match(/^\s*model:\s*(.+?)\s*$/);
      if (m) { model = m[1]; break; }
    }
  }
  const body = fmEnd !== -1 ? lines.slice(fmEnd + 1).join('\n').replace(/^\n+/, '') : raw;
  return { model, body };
}

// Deterministic UUID derived from md5("pokerbot-<bot>-v<epoch>"). Epoch 0
// matches the shell derivation in botmanager.sh::_md5_hex + bot_session_id
// (which uses plain "pokerbot-<bot>") — so fresh bots start byte-identical
// across code paths. Each periodic session clear increments BOT_EPOCHS[bot],
// yielding a brand-new UUID that abandons the old session.
function botSessionId(bot) {
  const epoch = BOT_EPOCHS.get(bot) || 0;
  const key = epoch === 0 ? `pokerbot-${bot}` : `pokerbot-${bot}-v${epoch}`;
  const hex = crypto.createHash('md5').update(key).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ── HTTP helpers ──────────────────────────────────
function getJSON(pathStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathStr, SERVER_HTTP);
    const req = http.get({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      timeout: 3000,
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`bad JSON: ${buf.slice(0, 120)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

function postJSON(pathStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathStr, SERVER_HTTP);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 3000,
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`bad JSON: ${buf.slice(0, 120)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(data); req.end();
  });
}

// ── Prompt assembly ───────────────────────────────
// Mirrors botmanager.sh::build_turn_prompt shape exactly:
//   <turn.md>
//   ---
//   <personality body>
//   ---
//   SERVER_URL=..., BOT_NAME=...
//
//   ## State
//   ```json
//   {...}
//   ```
// Stable prefix (turn.md + body + env) is cache-warm; dynamic state suffix is the only miss.
function buildTurnPrompt(bot, body, state) {
  const turnMd = fs.readFileSync(PROMPT_TURN, 'utf8');
  const parts = [
    turnMd,
    '',
    '---',
    '',
    body,
    '',
    '---',
    '',
    `SERVER_URL=${SERVER_HTTP}`,
    `BOT_NAME=${bot}`,
  ];
  // Carryover from the previous cleared session — injected only after a
  // session reset and only until the bot builds up new observations in the
  // new session. Empty string / absent = skip the block entirely.
  const memory = BOT_MEMORY.get(bot);
  if (memory && memory.trim()) {
    parts.push('', '## Carryover from previous hands', '', memory.trim());
  }
  parts.push(
    '',
    '## State',
    '',
    '```json',
    JSON.stringify(state, null, 2),
    '```',
  );
  return parts.join('\n');
}

// ── Spawn claude -p for one turn ──────────────────
// captureStdout: maintenance turns need the model's reply text (the summary).
// Normal game turns don't — they communicate via POST /action, so we discard
// stdout to avoid buffering a potentially large transcript in Node memory.
function runClaudeTurn(bot, model, prompt, useResume, captureStdout = false) {
  return new Promise((resolve) => {
    const sid = botSessionId(bot);
    const args = ['-p', prompt];
    if (useResume) args.push('--resume', sid);
    else args.push('--session-id', sid);
    if (model) args.push('--model', model);
    args.push('--permission-mode', 'bypassPermissions');

    const child = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // 120s cap — matches the shell version's run_with_timeout.
    const killer = setTimeout(() => {
      log.warn(`${bot}: claude -p timed out (120s) — killing`);
      try { child.kill('SIGKILL'); } catch {}
    }, 120000);

    let stderr = '';
    let stdout = '';
    if (captureStdout) child.stdout.on('data', d => { stdout += d.toString(); });
    else child.stdout.on('data', () => {});
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', (code) => {
      clearTimeout(killer);
      if (stderr) fs.appendFileSync(LOG_FILE, `\n[${ts()}] ${bot} code=${code}\n${stderr}`);
      resolve({ code, stderr, stdout });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      resolve({ code: -1, stderr: err.message, stdout: '' });
    });
  });
}

// Retry semantics: event-driven means we only wake on a `turn` event. If
// claude -p crashes or exits without POSTing /action, the server never fires
// a new turn → bot stalls until the 180s auto-fold. The old 2s polling loop
// retried "for free." We rebuild that guarantee inside this function: loop up
// to MAX_ATTEMPTS times, checking `currentActor` at the top of each iteration
// to decide whether another run is actually needed.
const MAX_ATTEMPTS = 3;
const RETRY_SLEEP_MS = 500;

// Run a one-off maintenance turn on the OLD session (--resume) whose only
// job is to extract a short bullet summary of the bot's observations so far.
// The summary text is captured from stdout and stashed in BOT_MEMORY[bot] —
// the caller then bumps BOT_EPOCHS[bot] to rotate the SID, abandoning the
// old (now-summarized) session. Next buildTurnPrompt will inject the summary
// as a "## Carryover" block so the fresh session doesn't start completely
// blind. Failures are non-fatal: if the summary prompt fails, the reset
// still happens and the new session simply has no carryover.
const MAINTENANCE_PROMPT = [
  '[SESSION MAINTENANCE — do NOT curl /action this turn]',
  '',
  'You have played about 10 hands. Your session transcript is about to be',
  'cleared to save context. Before that happens, distill what matters.',
  '',
  'Reply with ONLY a short markdown bullet list (3-6 bullets, no preamble,',
  'no trailing prose) summarizing what you have observed about your',
  'opponents that would be useful in future hands. Examples:',
  '- Opponent X: tight preflop, only 3-bets with premium holdings',
  '- Opponent Y: calls wide OOP, folds to double-barrel',
  '- Opponent Z showed a river bluff with missed draw — capable of it',
  '',
  'Do NOT curl /action. Do NOT output anything except the bullet list.',
].join('\n');

async function runMaintenance(bot, model) {
  log.info(`${bot}: running maintenance (summarize → clear session)`);
  const res = await runClaudeTurn(bot, model, MAINTENANCE_PROMPT, true /* useResume */, true /* captureStdout */);
  if (res.code !== 0) {
    log.warn(`${bot}: maintenance exited ${res.code} — proceeding with reset anyway, no carryover`);
    return '';
  }
  // Extract just the bullet lines. Strip any stray prose/whitespace.
  const summary = (res.stdout || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('-') || l.startsWith('*'))
    .join('\n');
  const bulletCount = summary.split('\n').filter(Boolean).length;
  if (bulletCount === 0) {
    log.warn(`${bot}: maintenance captured 0 bullets (bot likely ignored the format) — stdout head: ${(res.stdout || '').slice(0, 200)}`);
  } else {
    log.info(`${bot}: maintenance captured ${bulletCount} observation bullets`);
  }
  return summary;
}

async function invokeBotTurn(bot) {
  const parsed = parsePersonality(bot);
  if (!parsed) { log.warn(`${bot}: personality.md missing`); return; }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Top-of-loop state fetch does double duty:
    //   attempt 1 → initial pull (always needed)
    //   attempt 2+ → verification of the previous attempt. If claude -p
    //                successfully POSTed /action, `currentActor` has advanced
    //                and we exit cleanly. If server's 180s timer auto-folded
    //                us, same thing. Only if we're *still* currentActor do we
    //                actually need to retry.
    let state;
    try {
      state = await getJSON(`/state?player=${encodeURIComponent(bot)}`);
    } catch (e) {
      log.warn(`${bot}: /state fetch failed: ${e.message}`);
      return;
    }
    if (!state || !state.myCards) {
      log.warn(`${bot}: /state returned no myCards (player not seated?)`);
      return;
    }
    if (state.currentActor !== bot) {
      if (attempt > 1) log.debug(`${bot}: action confirmed (currentActor=${state.currentActor})`);
      return;
    }

    const prompt = buildTurnPrompt(bot, parsed.body, state);
    const hadSession = BOT_SESSIONS.has(bot);
    log.info(`turn: ${bot} attempt ${attempt}/${MAX_ATTEMPTS} (model: ${parsed.model || 'default'}) — ${hadSession ? 'resume' : 'first turn, creating session'}`);

    let res = await runClaudeTurn(bot, parsed.model, prompt, hadSession);

    // First-turn fallback: if --session-id collides with a pre-existing
    // session (e.g. BotManager restarted mid-game), retry with --resume.
    // Preserves cross-restart continuity. Doesn't count against MAX_ATTEMPTS.
    if (res.code !== 0 && !hadSession && /already in use/i.test(res.stderr || '')) {
      log.info(`${bot}: session exists — retrying with --resume`);
      res = await runClaudeTurn(bot, parsed.model, prompt, true);
    }

    if (res.code === 0) {
      BOT_SESSIONS.add(bot);
      log.debug(`${bot}: claude -p ok`);
    } else {
      log.warn(`${bot}: claude -p exited ${res.code} on attempt ${attempt}`);
    }

    // Small settle window before verifying via the next iteration's /state.
    // Skip on the final attempt — nothing to verify after.
    if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, RETRY_SLEEP_MS));
  }

  // Final verification: the in-loop state check gates the NEXT iteration,
  // so after attempt MAX_ATTEMPTS we never get to confirm whether it worked.
  // One last /state pull disambiguates "actually succeeded" from "truly stuck".
  try {
    const final = await getJSON(`/state?player=${encodeURIComponent(bot)}`);
    if (final && final.currentActor !== bot) {
      log.debug(`${bot}: action confirmed on final attempt (currentActor=${final.currentActor})`);
      return;
    }
  } catch { /* fall through to force-fold */ }

  // Truly stuck: 3 attempts burned and the bot is still currentActor. Rather
  // than let the server sit idle until its 180s auto-fold kicks in (blocks
  // everyone else at the table), submit a fold on the bot's behalf so the
  // hand advances immediately. This is pure fail-safe behavior — happens
  // when the model repeatedly refuses to invoke Bash or keeps crashing.
  log.warn(`${bot}: exhausted ${MAX_ATTEMPTS} attempts — force-folding`);
  try {
    const r = await postJSON('/action', { player: bot, action: 'fold' });
    if (r && r.ok) log.info(`${bot}: force-fold accepted`);
    else log.warn(`${bot}: force-fold rejected: ${JSON.stringify(r)}`);
  } catch (e) {
    log.warn(`${bot}: force-fold POST failed (${e.message}) — server's 180s timer will still auto-fold`);
  }
}

// ── WS event dispatch ─────────────────────────────
let ws = null;
let reconnectTimer = null;

async function handleTurn(actor, handNumber) {
  // Hand boundary detection: if this bot just crossed into a new handNumber,
  // increment its per-bot counter. When the counter hits RESET_AFTER_HANDS,
  // we summarize → clear → rotate SID before running the actual turn. This
  // runs BEFORE invokeBotTurn so the bot's first action of the new hand uses
  // a fresh session (and the carryover block in its prompt).
  const lastHand = BOT_LAST_HAND.get(actor);
  const crossedHand = lastHand !== undefined && handNumber !== lastHand;
  if (crossedHand) {
    const n = (BOT_HANDS_SINCE_RESET.get(actor) || 0) + 1;
    BOT_HANDS_SINCE_RESET.set(actor, n);
    if (n >= RESET_AFTER_HANDS) {
      const parsed = parsePersonality(actor);
      const model = parsed ? parsed.model : null;
      try {
        const summary = await runMaintenance(actor, model);
        BOT_MEMORY.set(actor, summary);
      } catch (e) {
        log.warn(`${actor}: maintenance threw (${e.message}) — clearing anyway`);
        BOT_MEMORY.set(actor, '');
      }
      // Rotate SID: bump epoch + force the next claude -p onto --session-id.
      BOT_EPOCHS.set(actor, (BOT_EPOCHS.get(actor) || 0) + 1);
      BOT_SESSIONS.delete(actor);
      BOT_HANDS_SINCE_RESET.set(actor, 0);
      log.info(`${actor}: session cleared (epoch → v${BOT_EPOCHS.get(actor)})`);
    }
  }
  BOT_LAST_HAND.set(actor, handNumber);

  await invokeBotTurn(actor);
}

function onTurn(actor, handNumber) {
  if (!isKnownBot(actor)) {
    log.debug(`ignore turn for ${actor} (not a managed bot)`);
    return;
  }
  if (INFLIGHT.has(actor)) {
    log.debug(`${actor}: already in-flight, skipping duplicate turn event`);
    return;
  }
  INFLIGHT.add(actor);
  handleTurn(actor, handNumber).finally(() => INFLIGHT.delete(actor));
}

function connect() {
  log.info(`connecting to ${SERVER_WS}...`);
  try { ws = new WebSocket(SERVER_WS); }
  catch (e) { log.warn(`connect failed: ${e.message}`); scheduleReconnect(); return; }

  ws.on('open', () => {
    log.info('connected to server (unjoined observer)');
  });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case 'turn':
        // Global broadcast added in poker-server.js action_required handler.
        // Payload: { player, handNumber, phase }.
        onTurn(msg.player, msg.handNumber);
        break;
      // Everything else (welcome, chat, player_*, hand_result, etc.) we ignore.
    }
  });

  ws.on('close', () => { log.warn('disconnected'); scheduleReconnect(); });
  ws.on('error', () => {});
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
}

// ── PID file + teardown ───────────────────────────
if (fs.existsSync(PID_FILE)) {
  const old = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (old && old !== process.pid) {
    log.info(`killing old BotManager (PID ${old})`);
    try { process.kill(old); } catch {}
  }
}
fs.writeFileSync(PID_FILE, String(process.pid));
log.info(`started (PID ${process.pid}) · claude=${CLAUDE_BIN} · bots=${BOT_ALLOW ? BOT_ALLOW.join(',') : '(any in bots/)'}`);

// Only delete PID_FILE if it still points at us. Restart sequence:
// new reads old's PID → new kills old → new writes PID_FILE with new PID →
// old's SIGTERM handler runs late. Without the ownership check, old's
// teardown would unlink the file new just wrote.
function cleanup() {
  log.info('shutting down');
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (pid === process.pid) fs.unlinkSync(PID_FILE);
    }
  } catch {}
  try { ws && ws.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

connect();
