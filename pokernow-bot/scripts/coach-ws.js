#!/usr/bin/env node
/**
 * coach-ws.js — CoachBot WebSocket Bridge (No Chrome Required)
 *
 * Connects directly to Poker Now via WebSocket, just like orchestrator.js does
 * for play bots. CC reads state.json, shows the user a nice poker table render,
 * user says "call" / "raise 200" / "fold" in CC, CC writes action.json.
 *
 * Used for pokernow.com fallback mode (when poker-server is not available).
 * No Chrome extension needed. Works in any CC environment.
 * User interacts via CC chat instead of a browser UI.
 *
 * Usage:
 *   node scripts/coach-ws.js <gameUrl> [--name BotName] [--seat N] [--stack N]
 *
 * Examples:
 *   node scripts/coach-ws.js "https://www.pokernow.com/games/pglXXXXXX"
 *   node scripts/coach-ws.js "https://www.pokernow.com/games/pglXXXXXX" --name MyPlayer --seat 3 --stack 2000
 *
 * Files (all in bot_profiles/CoachBot/):
 *   state.json    — always-current game state (CC reads this)
 *   turn.json     — written when it's our turn (CC renders + asks user)
 *   action.json   — CC writes here after user decides (bridge executes + deletes)
 *   history.jsonl — append-only game history
 *
 * Stop: Ctrl+C (graceful disconnect)
 */

const path = require('path');
const fs   = require('fs');
const http = require('http');
const WebSocket = require('ws');

const { PokerNowClient } = require('../lib/poker-now');
const { GameState }       = require('../lib/game-state');

// ── Parse CLI args ──────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    gameUrl: '',
    botName: 'CoachBot',
    seat:    5,
    stack:   1000,
  };

  // First positional arg = gameUrl
  if (args.length > 0 && !args[0].startsWith('--')) {
    config.gameUrl = args[0];
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1])  config.botName = args[++i];
    if (args[i] === '--seat' && args[i + 1])  config.seat = parseInt(args[++i]);
    if (args[i] === '--stack' && args[i + 1]) config.stack = parseInt(args[++i]);
    if (args[i] === '--url' && args[i + 1])   config.gameUrl = args[++i];
    if (args[i] === '--port' && args[i + 1]) config.httpPort = parseInt(args[++i]);
  }

  return config;
}

const HTTP_PORT = 3456; // pokernow bridge default (poker-server uses 3457)

const CONFIG = parseArgs();

// ── Paths ───────────────────────────────────────
const ENGINE_DIR   = path.join(__dirname, '..');
const PROJECT_ROOT = path.join(ENGINE_DIR, '..');
const PROFILE_DIR  = path.join(PROJECT_ROOT, 'bot_profiles', CONFIG.botName);

if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

const STATE_FILE   = path.join(PROFILE_DIR, 'state.json');
const TURN_FILE    = path.join(PROFILE_DIR, 'turn.json');
const ACTION_FILE  = path.join(PROFILE_DIR, 'action.json');
const HISTORY_FILE = path.join(PROFILE_DIR, 'history.jsonl');
const PID_FILE     = path.join(PROFILE_DIR, 'coach-ws.pid');

// ── Kill previous instance ──────────────────────
(function killOld() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
          console.log(`[INIT] Killing previous coach-ws (PID ${oldPid})...`);
          process.kill(oldPid, 'SIGTERM');
          const start = Date.now();
          while (Date.now() - start < 2000) {
            try { process.kill(oldPid, 0); } catch { break; }
          }
        } catch {}
      }
    }
  } catch {}
  fs.writeFileSync(PID_FILE, String(process.pid));
})();

// ── Logger ──────────────────────────────────────
function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}
const log = {
  info:  (...a) => console.log(`[${timestamp()}] [INFO]`, ...a),
  warn:  (...a) => console.log(`[${timestamp()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${timestamp()}] [ERR]`, ...a),
  debug: () => {},
};

// ── File helpers ────────────────────────────────
function writeJSON(fp, data) {
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}
function readJSON(fp) {
  try {
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, 'utf-8').trim();
      if (raw) return JSON.parse(raw);
    }
  } catch {}
  return null;
}
function deleteFile(fp) {
  try { fs.unlinkSync(fp); } catch {}
}
// Unified history format — same as poker-server's history.jsonl
// Event types: hand_start, action, board, hand_end
function logEvent(event) {
  const ordered = { ts: new Date().toISOString(), ...event };
  try { fs.appendFileSync(HISTORY_FILE, JSON.stringify(ordered) + '\n'); } catch {}
}
const ACT_NAME = { call:'call', check:'check', fold:'fold', bet:'bet', raise:'raise',
  small_blind:'sb', big_blind:'bb', allin:'allin' };

// ── Recent hand history (parses unified event format) ──
function getRecentHandsSummary(maxHands = 10) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const lines = fs.readFileSync(HISTORY_FILE, 'utf-8').trim().split('\n');
    const hands = [];
    let cur = null;
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'hand_start') {
          cur = { hand: ev.hand, blinds: ev.blinds, positions: ev.positions,
                  players: ev.players, actions: [], board: [] };
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
      } catch {}
    }
    return hands.slice(-maxHands);
  } catch { return []; }
}

// ── Valid actions ────────────────────────────────
const VALID_ACTIONS = {
  fold: { fields: [] },
  check: { fields: [] },
  call: { fields: [] },
  raise: { fields: ['amount'] },
  bet: { fields: ['amount'] },
  sit: { fields: [], optional: ['seat', 'stack'] },
  request_seat: { fields: [], optional: ['seat', 'stack'] },
  sit_back: { fields: [] },
  leave_seat: { fields: [] },
  stand_up: { fields: [] },
  chat: { fields: ['message'] },
  start_game: { fields: [] },
  stop_game: { fields: [] },
  pause: { fields: [] },
  resume: { fields: [] },
  next_hand: { fields: [] },
  approve_player: { fields: ['player_id'], optional: ['stack'] },
  remove_player: { fields: ['player_id'] },
};

function validateAction(action) {
  if (!action || typeof action !== 'object') return 'Action must be JSON object';
  const act = (action.action || '').toLowerCase();
  if (!act) return 'Missing "action" field';
  const spec = VALID_ACTIONS[act];
  if (!spec) return `Unknown action "${act}"`;
  for (const f of spec.fields) {
    if (action[f] === undefined || action[f] === null || action[f] === '') {
      return `Action "${act}" requires "${f}"`;
    }
  }
  if ((act === 'raise' || act === 'bet') && (!parseInt(action.amount) || parseInt(action.amount) <= 0)) {
    return `Action "${act}" requires a positive amount`;
  }
  return null;
}

// ══════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════
async function main() {
  if (!CONFIG.gameUrl) {
    log.error('Usage: node scripts/coach-ws.js <gameUrl> [--name Name] [--seat N] [--stack N]');
    process.exit(1);
  }

  console.log(`
+======================================================+
|  CoachBot WebSocket Bridge (No Chrome)                |
|  Player: ${CONFIG.botName.padEnd(43)}  |
|  Game: ${CONFIG.gameUrl.substring(0, 45).padEnd(45)}  |
+======================================================+
`);
  log.info(`PID: ${process.pid}`);

  // Clean stale files
  deleteFile(TURN_FILE);
  deleteFile(ACTION_FILE);

  // ── Create client & game state ────────────────
  const client = new PokerNowClient({
    gameUrl:    CONFIG.gameUrl,
    botName:    CONFIG.botName,
    logger:     log,
    workDir:    PROJECT_ROOT,
    profileDir: PROFILE_DIR,
  });

  const gameState = new GameState({
    botName: CONFIG.botName,
    logger:  log,
  });

  let lastPhase = '';
  let actionInProgress = false;
  let actionWatcher = null;
  const chatMessages = [];
  const MAX_CHAT = 50;
  let currentHandNum = 0;       // track hand number for history events
  let lastLoggedBoard = 0;      // track board cards count to detect new board events
  let loggedActionKeys = new Set(); // track which actions we've already logged

  // ── Forward declarations for WebSocket broadcast (used by event handlers below) ──
  const browserClients = new Set();
  let wsBroadcast, wsSend, buildPokerServerState;

  // ── Wire events ───────────────────────────────

  // Game events → parser
  client.on('game_event', (eventName, args) => {
    if (eventName !== 'gC') log.info(`Event: ${eventName}`);
    gameState.processEvent(eventName, args);
  });

  // Chat
  client.on('game_event', (eventName, args) => {
    if (eventName === 'newChatMessage' && args) {
      const msg = { at: args.at, playerName: args.playerName, playerID: args.playerID, message: args.message };
      chatMessages.push(msg);
      if (chatMessages.length > MAX_CHAT) chatMessages.shift();
      log.info(`Chat: ${msg.playerName}: ${msg.message}`);
    }
  });

  // Registered
  client.on('registered', (data) => {
    if (data?.currentPlayer) {
      gameState.playerId = data.currentPlayer.id;
      log.info(`Registered as: ${data.currentPlayer.id} (${CONFIG.botName})`);
    }
  });

  // State updated
  gameState.on('state_updated', (hand) => {
    const ctx = gameState.getClaudeContext();
    ctx.playerId = gameState.playerId;
    ctx.timestamp = Date.now();
    ctx.isMyTurn = !!hand.isMyTurn;
    ctx.chatMessages = chatMessages.slice(-20);

    writeJSON(STATE_FILE, ctx);

    // Broadcast to browser clients (poker-server compatible format)
    if (wsBroadcast) {
      const pokerState = buildPokerServerState(hand);
      pokerState.myCards = hand.myCards || [];
      pokerState.myStack = hand.myStack || 0;
      pokerState.isMyTurn = !!hand.isMyTurn;
      if (hand.isMyTurn) {
        pokerState.callAmount = hand.callAmount || 0;
        pokerState.minRaise = hand.minRaise || 0;
        pokerState.maxRaise = hand.maxRaise || 0;
      }
      wsBroadcast('state', { state: pokerState });
      if (hand.isMyTurn) {
        wsBroadcast('your_turn', {
          player: CONFIG.botName,
          callAmount: hand.callAmount || 0,
          minRaise: hand.minRaise || 0,
          maxRaise: hand.maxRaise || 0,
          pot: hand.pot || 0,
        });
      }
    }

    const phase = hand.phase;

    // ── History: hand_start ──
    if (phase === 'preflop' && lastPhase !== 'preflop') {
      log.info('============= NEW HAND =============');
      actionInProgress = false;
      currentHandNum = hand.handNumber ?? (currentHandNum + 1);
      lastLoggedBoard = 0;
      loggedActionKeys = new Set();

      // Build players map — pokernow only shows our own cards, others are hidden
      const players = {};
      for (const p of hand.players) {
        if (p.isMe) {
          players[p.name] = [hand.myCards || [], hand.myStack || p.stack];
        } else {
          players[p.name] = [[], p.stack];
        }
      }

      // Calculate positions from dealer seat
      const positions = {};
      const readyPlayers = hand.players.filter(p => p.status === 'inGame' || !p.status);
      const n = readyPlayers.length;
      if (n > 0 && hand.dealer !== null) {
        const dealerIdx = readyPlayers.findIndex(p => p.seat === hand.dealer);
        if (dealerIdx >= 0) {
          if (n === 2) {
            positions[readyPlayers[dealerIdx].name] = 'BTN';
            positions[readyPlayers[(dealerIdx + 1) % n].name] = 'BB';
          } else if (n === 3) {
            positions[readyPlayers[dealerIdx].name] = 'BTN';
            positions[readyPlayers[(dealerIdx + 1) % n].name] = 'SB';
            positions[readyPlayers[(dealerIdx + 2) % n].name] = 'BB';
          } else {
            const labels = ['BTN', 'SB', 'BB'];
            const midLabels = { 1: ['UTG'], 2: ['UTG','CO'], 3: ['UTG','MP','CO'],
              4: ['UTG','UTG+1','MP','CO'], 5: ['UTG','UTG+1','MP','HJ','CO'] };
            for (let i = 0; i < n; i++) {
              const name = readyPlayers[(dealerIdx + i) % n].name;
              if (i < 3) { positions[name] = labels[i]; }
              else {
                const mid = midLabels[n - 3] || [];
                positions[name] = mid[i - 3] || `UTG+${i - 3}`;
              }
            }
          }
        }
      }

      logEvent({
        type: 'hand_start', hand: currentHandNum,
        blinds: [hand.smallBlind || 10, hand.bigBlind || 20],
        positions, players,
      });
    }

    // ── History: board events ──
    const boardLen = (hand.communityCards || []).length;
    if (boardLen > lastLoggedBoard && boardLen >= 3) {
      logEvent({ type: 'board', hand: currentHandNum, cards: [...hand.communityCards] });
      lastLoggedBoard = boardLen;
    }

    // ── History: action events (log any new actions we haven't seen) ──
    for (const a of (hand.actions || [])) {
      const act = ACT_NAME[a.action] || a.action;
      const actionStr = a.amount ? `${a.actor} ${act} ${a.amount}` : `${a.actor} ${act}`;
      const key = `${currentHandNum}|${actionStr}`;
      if (!loggedActionKeys.has(key)) {
        loggedActionKeys.add(key);
        logEvent({ type: 'action', hand: currentHandNum, action: actionStr });
      }
    }

    // ── History: hand_end ──
    if ((phase === 'showdown' || phase === 'waiting') &&
        lastPhase !== 'showdown' && lastPhase !== 'waiting' && lastPhase !== '') {
      const stacks = {};
      const shown = [];
      for (const p of hand.players) {
        stacks[p.name] = p.stack;
        if (p.cards && p.cards.length > 0 && !p.folded) shown.push(p.name);
      }
      const results = (hand.results || []).map(r =>
        `${r.winner || r.name || '?'} ${r.amount || 0}${r.hand ? ' ' + r.hand : ''}`
      );
      logEvent({ type: 'hand_end', hand: currentHandNum, results, shown, stacks });

      // Broadcast hand_result to browser (poker-server compatible)
      if (typeof wsBroadcast === 'function') {
        const publicPlayers = (hand.players || []).map(p => {
          const obj = { name: p.name, seat: p.seat, stack: p.stack, folded: !!p.folded };
          if (p.cards && p.cards.length > 0 && !p.folded) obj.cards = p.cards;
          return obj;
        });
        wsBroadcast('hand_result', {
          handNumber: currentHandNum,
          positions: buildPokerServerState(hand).positions,
          results: hand.results || [],
          board: hand.communityCards || [],
          players: publicPlayers,
          pot: hand.pot || 0,
          actions: (hand.actions || []).map(a => ({
            actor: a.actor, action: a.action, amount: a.amount || undefined, phase: a.phase,
          })),
          blinds: [hand.smallBlind || 10, hand.bigBlind || 20],
        });
      }

      deleteFile(TURN_FILE);
      actionInProgress = false;
    }

    lastPhase = phase;
  });

  // MY TURN
  gameState.on('my_turn', (turnInfo) => {
    if (actionInProgress) return;

    const ctx = gameState.getClaudeContext();
    ctx.playerId = gameState.playerId;
    ctx.isMyTurn = true;
    ctx.turnInfo = turnInfo;
    ctx.timestamp = Date.now();
    ctx.recentHands = getRecentHandsSummary(10);
    ctx.chatMessages = chatMessages.slice(-20);

    log.info(`★ MY TURN! call=$${turnInfo.callAmount}, pot=$${turnInfo.pot}, phase=${turnInfo.phase}`);
    log.info(`  Cards: ${gameState.hand.myCards.join(' ') || 'none'}`);
    log.info(`  Board: ${gameState.hand.communityCards.join(' ') || 'none'}`);
    log.info(`  Waiting for action.json from CC...`);

    writeJSON(TURN_FILE, ctx);
    startActionWatcher();
  });

  // Cards dealt
  gameState.on('cards_dealt', (cards) => {
    log.info(`My cards: ${cards.join(' ')}`);
    if (wsBroadcast) {
      wsBroadcast('cards', { cards });
    }
  });

  // Board updated
  gameState.on('board_updated', (board) => {
    log.info(`Board: ${board.join(' ')}`);
  });

  // Showdown — logged via hand_end in state_updated, just reset action flag here
  gameState.on('showdown', (hand) => {
    log.info(`SHOWDOWN | pot=${hand.pot}`);
    actionInProgress = false;
  });

  gameState.on('action_failed', () => { actionInProgress = false; });
  gameState.on('new_hand', () => { actionInProgress = false; });

  // Connection
  client.on('sio_connected', () => {
    log.info('Socket.IO connected');
    startActionWatcher();
    setTimeout(async () => {
      log.info('Sending SIT_BACK...');
      client.sendPokerAction('PLAYER_SIT_BACK');
      setTimeout(async () => {
        log.info(`Requesting seat ${CONFIG.seat} (stack ${CONFIG.stack})...`);
        try {
          await client.requestSeat(CONFIG.seat, CONFIG.stack);
          log.info('Seat request sent');
        } catch (e) {
          log.info(`Seat request: ${e.message} (may already be seated)`);
        }
      }, 2000);
    }, 2000);
  });

  client.on('disconnected', () => {
    log.error('Permanently disconnected');
    stopActionWatcher();
    process.exit(1);
  });

  // ── Action watcher ────────────────────────────
  function startActionWatcher() {
    if (actionWatcher) return;
    log.info('Action watcher STARTED');
    actionWatcher = setInterval(() => {
      if (!fs.existsSync(ACTION_FILE)) return;

      let raw = '';
      try { raw = fs.readFileSync(ACTION_FILE, 'utf-8'); } catch { return; }

      let action;
      try { action = JSON.parse(raw.trim()); } catch (e) {
        log.warn(`Bad action.json: ${e.message}`);
        deleteFile(ACTION_FILE);
        return;
      }

      log.info(`Picked up action: ${JSON.stringify(action)}`);
      deleteFile(ACTION_FILE);
      executeAction(action).catch(e => {
        log.error(`executeAction error: ${e.message}`);
        actionInProgress = false;
      });
    }, 500);
  }

  function stopActionWatcher() {
    if (actionWatcher) {
      clearInterval(actionWatcher);
      actionWatcher = null;
    }
  }

  async function executeAction(action) {
    const error = validateAction(action);
    if (error) {
      log.warn(`Validation: ${error}`);
      return;
    }

    const act = (action.action || '').toLowerCase();
    const amount = action.amount ? parseInt(action.amount) : undefined;

    // Chat
    if (act === 'chat') {
      const msg = action.message || '';
      if (!msg) return;
      const sent = client.sendChat(msg);
      log.info(`Chat: "${msg}" → ${sent ? 'OK' : 'FAIL'}`);
      return;
    }

    // Host actions
    if (['start_game', 'stop_game', 'pause', 'resume', 'next_hand', 'approve_player', 'remove_player'].includes(act)) {
      let sent = false;
      const pid = action.player_id || action.playerId || '';
      switch (act) {
        case 'start_game':     sent = await client.startGame(); break;
        case 'stop_game':      sent = client.stopGame(); break;
        case 'pause':          sent = client.pauseGame(); break;
        case 'resume':         sent = client.resumeGame(); break;
        case 'next_hand':      sent = client.startNextHand(); break;
        case 'approve_player': sent = await client.approvePlayer(pid, action.stack || 1000); break;
        case 'remove_player':  sent = await client.removePlayer(pid); break;
      }
      log.info(`Host: ${act} → ${sent ? 'OK' : 'FAIL'}`);
      return;
    }

    // Seat actions
    if (act === 'stand_up' || act === 'leave_seat') {
      const sent = client.emitEvent('action', { type: 'QNH' });
      log.info(`Action: leave_seat → ${sent ? 'OK' : 'FAIL'}`);
      return;
    }
    if (act === 'sit_back') {
      const sent = client.sendPokerAction('PLAYER_SIT_BACK');
      log.info(`Action: sit_back → ${sent ? 'OK' : 'FAIL'}`);
      return;
    }
    if (act === 'sit' || act === 'request_seat') {
      const seat = action.seat || CONFIG.seat;
      const stack = action.stack || CONFIG.stack;
      try {
        await client.requestSeat(seat, stack);
        log.info(`>>> Seat ${seat} requested (stack ${stack})`);
      } catch (e) {
        log.warn(`Seat request failed: ${e.message}`);
      }
      return;
    }

    // Game actions
    actionInProgress = true;
    let sent = false;
    switch (act) {
      case 'fold':  sent = client.fold(); break;
      case 'check': sent = client.check(); break;
      case 'call':  sent = client.call(); break;
      case 'raise':
      case 'bet':   sent = client.raise(amount || 0); break;
      default:      sent = client.sendPokerAction(`PLAYER_${act.toUpperCase()}`);
    }

    log.info(`Action: ${act}${amount ? ' $' + amount : ''} → ${sent ? 'OK' : 'FAIL'}`);
    deleteFile(TURN_FILE);

    setTimeout(() => { actionInProgress = false; }, 1000);
  }

  // ── HTTP server for browser UI ─────────────────
  const httpPort = CONFIG.httpPort || HTTP_PORT;
  const TABLE_HTML_PATH = path.join(__dirname, '..', '..', 'poker-server', 'public', 'poker-table.html');

  const httpServer = http.createServer((req, res) => {
    // CORS for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // GET / → poker table HTML
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      try {
        const html = fs.readFileSync(TABLE_HTML_PATH, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('poker-table.html not found: ' + e.message);
      }
      return;
    }

    // GET /state → current game state JSON
    if (req.method === 'GET' && req.url === '/state') {
      const state = readJSON(STATE_FILE);
      if (state) {
        // Also include turn info if it's our turn
        const turn = readJSON(TURN_FILE);
        if (turn) {
          state.isMyTurn = true;
          state.turnInfo = turn.turnInfo;
          if (turn.recentHands) state.recentHands = turn.recentHands;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ phase: 'waiting', players: [], pot: 0, communityCards: [], myCards: [] }));
      }
      return;
    }

    // POST /action → write action.json (from browser buttons)
    if (req.method === 'POST' && req.url === '/action') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const action = JSON.parse(body);
          const error = validateAction(action);
          if (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error }));
            return;
          }
          writeJSON(ACTION_FILE, action);
          log.info(`HTTP action: ${JSON.stringify(action)}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, action }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  httpServer.listen(httpPort, () => {
    log.info(`HTTP server: http://localhost:${httpPort} (poker table UI)`);
  });

  // ── WebSocket server (broadcasts to browser clients, same protocol as poker-server) ──
  const wss = new WebSocket.Server({ server: httpServer });

  wss.on('connection', (clientWs) => {
    const clientInfo = { ws: clientWs, playerName: '' };
    browserClients.add(clientInfo);
    log.info(`Browser client connected (${browserClients.size} total)`);

    // Send welcome
    const hand = gameState.hand;
    wsSend(clientWs, 'welcome', {
      blinds: `${hand.smallBlind || 10}/${hand.bigBlind || 20}`,
      defaultStack: CONFIG.stack || 1000,
      players: (hand.players || []).map(p => ({ name: p.name, stack: p.stack })),
      serverType: 'pokernow',
    });

    clientWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'join' || msg.type === 'reconnect') {
          clientInfo.playerName = msg.name || CONFIG.botName;
          wsSend(clientWs, 'joined', { name: clientInfo.playerName, seat: 0, stack: hand.myStack || CONFIG.stack });
          // Send current state immediately
          const state = buildPokerServerState(hand);
          wsSend(clientWs, 'state', { state });
          if (hand.myCards && hand.myCards.length > 0) {
            wsSend(clientWs, 'cards', { cards: hand.myCards });
          }
        } else if (msg.type === 'action') {
          // Write action.json for bridge to execute
          const action = { action: msg.action };
          if (msg.amount) action.amount = msg.amount;
          writeJSON(ACTION_FILE, action);
          log.info(`WS action from browser: ${JSON.stringify(action)}`);
        }
      } catch {}
    });

    clientWs.on('close', () => {
      browserClients.delete(clientInfo);
      log.info(`Browser client disconnected (${browserClients.size} remaining)`);
    });
  });

  wsSend = function(clientWs, type, data) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type, ...data }));
    }
  };

  wsBroadcast = function(type, data) {
    const msg = JSON.stringify({ type, ...data });
    for (const c of browserClients) {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
    }
  };

  // ── Convert pokernow state to poker-server format ──
  buildPokerServerState = function(hand) {
    if (!hand) return { phase: 'waiting', players: [], pot: 0, communityCards: [], actions: [] };

    const players = (hand.players || []).map((p, i) => ({
      name: p.name,
      seat: p.seat !== undefined ? p.seat : i,
      stack: p.stack || 0,
      bet: p.bet || 0,
      folded: !!p.folded,
      allIn: p.stack === 0 && !p.folded,
      isMe: !!p.isMe,
      ...(p.isMe && hand.myCards ? { cards: hand.myCards } : {}),
    }));

    // Build positions map
    const positions = {};
    const readyPlayers = (hand.players || []).filter(p => !p.folded && (p.status === 'inGame' || !p.status));
    const n = readyPlayers.length;
    if (n > 0 && hand.dealer !== null && hand.dealer !== undefined) {
      const dealerIdx = readyPlayers.findIndex(p => p.seat === hand.dealer);
      if (dealerIdx >= 0) {
        if (n === 2) {
          positions[readyPlayers[dealerIdx].name] = 'BTN';
          positions[readyPlayers[(dealerIdx + 1) % n].name] = 'BB';
        } else if (n === 3) {
          positions[readyPlayers[dealerIdx].name] = 'BTN';
          positions[readyPlayers[(dealerIdx + 1) % n].name] = 'SB';
          positions[readyPlayers[(dealerIdx + 2) % n].name] = 'BB';
        } else {
          const labels = ['BTN', 'SB', 'BB'];
          const midLabels = { 1: ['UTG'], 2: ['UTG','CO'], 3: ['UTG','MP','CO'] };
          for (let i = 0; i < n; i++) {
            const name = readyPlayers[(dealerIdx + i) % n].name;
            if (i < 3) { positions[name] = labels[i]; }
            else {
              const mid = midLabels[n - 3] || [];
              positions[name] = mid[i - 3] || `UTG+${i - 3}`;
            }
          }
        }
      }
    }

    // Find current actor (pokernow tells us isMyTurn, but we don't know other players' turns directly)
    let currentActor = null;
    if (hand.isMyTurn) {
      const me = (hand.players || []).find(p => p.isMe);
      if (me) currentActor = me.name;
    }

    return {
      phase: hand.phase || 'waiting',
      handNumber: hand.handNumber ?? currentHandNum ?? 0,
      pot: hand.pot || 0,
      communityCards: hand.communityCards || [],
      players,
      actions: (hand.actions || []).map(a => ({
        actor: a.actor, action: a.action, amount: a.amount || undefined, phase: a.phase,
      })),
      currentActor,
      dealerSeat: hand.dealer,
      positions,
      smallBlind: hand.smallBlind || 10,
      bigBlind: hand.bigBlind || 20,
      currentBet: hand.currentBet || 0,
    };
  };

  // ── Connect ───────────────────────────────────
  try {
    log.info(`Connecting: ${CONFIG.gameUrl}`);
    await client.connect();
    log.info('WebSocket connected!');

    // Auto-request seat
    setTimeout(async () => {
      log.info(`Auto-requesting seat ${CONFIG.seat} (stack ${CONFIG.stack})...`);
      try {
        await client.requestSeat(CONFIG.seat, CONFIG.stack);
      } catch (e) {
        log.info(`Seat: ${e.message}`);
      }
    }, 3000);

    console.log(`
  COACH MODE — WebSocket Direct (No Chrome)
  Player: ${CONFIG.botName}
  PID: ${process.pid}

  Poker table UI: http://localhost:${httpPort}

  How it works:
  1. Connected to Poker Now via WebSocket
  2. Open http://localhost:${httpPort} in browser to see the table
  3. When it's your turn → click action buttons in browser
     OR tell CC your action → CC writes action.json
  4. This script executes the action

  Press Ctrl+C to stop.
`);

  } catch (e) {
    log.error(`Connection failed: ${e.message}`);
    deleteFile(PID_FILE);
    process.exit(1);
  }

  // ── Graceful shutdown ─────────────────────────
  function cleanup() {
    log.info('Shutting down coach-ws...');
    stopActionWatcher();
    try { httpServer.close(); } catch {}
    deleteFile(TURN_FILE);
    deleteFile(ACTION_FILE);
    deleteFile(STATE_FILE);
    deleteFile(PID_FILE);
    client.disconnect();
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch(e => {
  log.error(`Fatal: ${e.message}`);
  try { fs.unlinkSync(PID_FILE); } catch {}
  process.exit(1);
});
