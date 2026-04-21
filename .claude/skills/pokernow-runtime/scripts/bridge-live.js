#!/usr/bin/env node
/**
 * bridge-live.js — Poker Now Long-Running Bridge
 *
 * Keeps WebSocket alive, detects turns, communicates with Claude Code via files.
 *
 * How it works:
 *   1. Connects to Poker Now, stays connected (pings keep it alive)
 *   2. When it's bot's turn  → writes turn.json  (game state for Claude to read)
 *   3. Claude writes action.json → bridge reads it, executes, deletes the file
 *   4. All events logged to bridge.log, history to history.jsonl
 *
 * Usage:
 *   node scripts/bridge-live.js              # run in terminal, stays alive
 *   node scripts/bridge-live.js --seat       # also request seat on start
 *
 * Files (all relative to pokernow-runtime/):
 *   turn.json      — written when it's our turn (Claude reads this)
 *   action.json    — Claude writes here to send an action (bridge reads + deletes)
 *   state.json     — always-current game state snapshot
 *   history.jsonl  — append-only game history
 *   bridge.log     — bridge runtime log (when run with output redirect)
 *
 * Stop: Ctrl+C (graceful disconnect)
 */

const path = require('path');
const fs   = require('fs');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch {} // optional

const { PokerNowClient } = require('../lib/poker-now');
const { GameState }       = require('../lib/game-state');

// ── Config ───────────────────────────────────────
const ROOT_DIR = path.join(__dirname, '..');
const WORK_DIR = process.env.BOT_WORK_DIR || ROOT_DIR;
const CONFIG = {
  gameUrl:  process.env.GAME_URL || '',
  botName:  process.env.BOT_NAME || 'ARIA_Bot',
  seat:     parseInt(process.env.SEAT || '5'),
  stack:    parseInt(process.env.STACK || '1000'),
};

// Bot profile directory — each bot's files live under PokerBot/game-data/{botName}/
const PROJECT_ROOT = path.join(ROOT_DIR, '..', '..', '..');  // PokerBot/
const PROFILE_DIR  = path.join(PROJECT_ROOT, 'game-data', CONFIG.botName);
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

const TURN_FILE    = path.join(PROFILE_DIR, 'turn.json');
const ACTION_FILE  = path.join(PROFILE_DIR, 'action.json');
const STATE_FILE   = path.join(PROFILE_DIR, 'state.json');
const HISTORY_FILE = path.join(PROFILE_DIR, 'history.jsonl');
const PID_FILE     = path.join(PROFILE_DIR, 'bridge.pid');

// ── Kill previous instance on startup ────────────
(function killOldBridge() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0); // check if alive
          console.log(`[INIT] Killing previous bridge (PID ${oldPid})...`);
          process.kill(oldPid, 'SIGTERM');
          // Wait up to 2s for it to die
          const start = Date.now();
          while (Date.now() - start < 2000) {
            try { process.kill(oldPid, 0); } catch { break; }
          }
          console.log(`[INIT] Old process ${oldPid} terminated.`);
        } catch {
          // Process already dead — that's fine
        }
      }
    }
  } catch {}
  // Write our own PID
  fs.writeFileSync(PID_FILE, String(process.pid));
})();

// ── Logger ───────────────────────────────────────
function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

const log = {
  info:  (...a) => console.log(`[${timestamp()}] [INFO]`, ...a),
  warn:  (...a) => console.log(`[${timestamp()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${timestamp()}] [ERR]`, ...a),
  debug: () => {},  // silent by default; set to console.log for verbose
};

// ── History logging ──────────────────────────────
function logHistory(type, data) {
  const record = {
    time: new Date().toISOString(),
    type,
    ...data,
  };
  try {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n');
  } catch (e) { /* don't break gameplay over logging */ }
}

// ── File helpers ─────────────────────────────────
function writeJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

function readJSON(filepath) {
  try {
    if (fs.existsSync(filepath)) {
      const raw = fs.readFileSync(filepath, 'utf-8').trim();
      if (raw) return JSON.parse(raw);
    }
  } catch (e) {
    log.warn(`Failed to read ${path.basename(filepath)}: ${e.message}`);
  }
  return null;
}

function deleteFile(filepath) {
  try { fs.unlinkSync(filepath); } catch {}
}

// ── Recent hand history for Claude context ───────
// Reads history.jsonl and extracts the last N complete hands
// Returns a compact summary array for decision-making
function getRecentHandsSummary(maxHands = 10) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];

    const lines = fs.readFileSync(HISTORY_FILE, 'utf-8').trim().split('\n');
    const hands = [];
    let currentHand = null;

    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        if (r.type === 'hand_start') {
          currentHand = {
            time:      r.time,
            myCards:   r.myCards || [],
            myStack:   r.myStack,
            players:   (r.players || []).map(p => p.name),
            blinds:    r.bigBlind,
            actions:   [],
            result:    null,
          };
        } else if (r.type === 'action' && currentHand) {
          currentHand.actions.push({
            action: r.action,
            amount: r.amount,
          });
        } else if (r.type === 'hand_end' && currentHand) {
          currentHand.board   = r.board || [];
          currentHand.pot     = r.pot;
          currentHand.results = r.results || [];
          currentHand.endStack = r.myStack;
          // Include opponent shown cards
          const shown = (r.players || []).filter(p => p.cards && !p.isMe);
          if (shown.length > 0) {
            currentHand.opponentCards = shown.map(p => ({ name: p.name, cards: p.cards }));
          }
          hands.push(currentHand);
          currentHand = null;
        }
      } catch {}
    }

    return hands.slice(-maxHands);
  } catch {
    return [];
  }
}

// ── Main ─────────────────────────────────────────
async function main() {
  if (!CONFIG.gameUrl) {
    log.error('No GAME_URL set. Put it in pokernow-runtime/.env');
    process.exit(1);
  }

  console.log(`
+======================================================+
|  ARIA PokerBot — Long-Running Bridge                  |
|  Game: ${CONFIG.gameUrl.substring(0, 45).padEnd(45)}  |
+======================================================+
`);

  log.info(`Bridge PID: ${process.pid} (written to ${path.basename(PID_FILE)})`);

  // Clean up stale files from previous run
  deleteFile(TURN_FILE);
  deleteFile(ACTION_FILE);

  // ── Create client & game state ─────────────────
  const client = new PokerNowClient({
    gameUrl:    CONFIG.gameUrl,
    botName:    CONFIG.botName,
    logger:     log,
    workDir:    PROJECT_ROOT,   // PokerBot/
    profileDir: PROFILE_DIR,    // bot-management/bots/{botName}/
  });

  const gameState = new GameState({
    botName: CONFIG.botName,
    logger:  log,
  });

  // Track state for hand lifecycle
  let lastPhase = '';
  let actionInProgress = false;
  let actionWatcher = null;
  const chatMessages = [];  // recent chat messages
  const MAX_CHAT_MESSAGES = 50;

  // ── Wire events ────────────────────────────────

  // 1) All game events → GameState parser
  client.on('game_event', (eventName, args) => {
    if (eventName !== 'gC') {
      log.info(`Event: ${eventName}`);
    }
    gameState.processEvent(eventName, args);
  });

  // 1b) Chat messages
  client.on('game_event', (eventName, args) => {
    if (eventName === 'newChatMessage' && args) {
      const msg = {
        at: args.at,
        playerName: args.playerName,
        playerID: args.playerID,
        message: args.message,
      };
      chatMessages.push(msg);
      if (chatMessages.length > MAX_CHAT_MESSAGES) chatMessages.shift();
      log.info(`Chat from ${msg.playerName}: ${msg.message}`);
      logHistory('chat_received', msg);
    }
  });

  // 2) Registered — we get our player ID
  client.on('registered', (data) => {
    if (data && data.currentPlayer) {
      gameState.playerId = data.currentPlayer.id;
      log.info(`Registered as: ${data.currentPlayer.id} (${CONFIG.botName})`);
    }
  });

  // 3) State updated — save snapshot + detect hand lifecycle
  gameState.on('state_updated', (hand) => {
    const ctx = gameState.getClaudeContext();
    ctx.playerId = gameState.playerId;
    ctx.timestamp = Date.now();
    ctx.isMyTurn = !!hand.isMyTurn;
    ctx.chatMessages = chatMessages.slice(-20);  // last 20 chat messages

    // Save current state (always available for Claude to read)
    writeJSON(STATE_FILE, ctx);

    // ── Hand lifecycle detection ──
    const phase = hand.phase;

    // Hand start: transition into preflop
    if (phase === 'preflop' && lastPhase !== 'preflop') {
      log.info('============= NEW HAND =============');
      actionInProgress = false;
      logHistory('hand_start', {
        myCards:    hand.myCards,
        myStack:   hand.myStack,
        players:   hand.players.map(p => ({ name: p.name, stack: p.stack, isMe: p.isMe })),
        smallBlind: hand.smallBlind,
        bigBlind:   hand.bigBlind,
      });
    }

    // Hand end: transition to showdown or waiting
    if ((phase === 'showdown' || phase === 'waiting') &&
        lastPhase !== 'showdown' && lastPhase !== 'waiting' && lastPhase !== '') {
      logHistory('hand_end', {
        myCards:  hand.myCards,
        board:   hand.communityCards,
        pot:     hand.pot,
        myStack: hand.myStack,
        results: hand.results,
        players: hand.players.map(p => {
          const out = { name: p.name, stack: p.stack, folded: p.folded, isMe: p.isMe };
          if (p.cards && p.cards.length > 0) out.cards = p.cards;
          return out;
        }),
        actions: hand.actions.slice(-15),
      });
      // Clean up turn file when hand ends
      deleteFile(TURN_FILE);
      actionInProgress = false;
    }

    lastPhase = phase;

    // Log state to history
    logHistory('state', {
      phase,
      myCards:  hand.myCards,
      board:   hand.communityCards,
      pot:     hand.pot,
      myStack: hand.myStack,
      isMyTurn: hand.isMyTurn,
      players: hand.players.map(p => {
        const out = { name: p.name, stack: p.stack, bet: p.bet, folded: p.folded, isMe: p.isMe };
        if (p.cards && p.cards.length > 0) out.cards = p.cards;
        return out;
      }),
    });
  });

  // 4) MY TURN — write turn.json and start watching for action.json
  gameState.on('my_turn', (turnInfo) => {
    if (actionInProgress) {
      log.debug('Action already in progress, skipping turn signal');
      return;
    }

    const ctx = gameState.getClaudeContext();
    ctx.playerId = gameState.playerId;
    ctx.isMyTurn = true;
    ctx.turnInfo = turnInfo;
    ctx.timestamp = Date.now();

    log.info(`★ MY TURN! call=$${turnInfo.callAmount}, pot=$${turnInfo.pot}, phase=${turnInfo.phase}`);
    log.info(`  Cards: ${gameState.hand.myCards.join(' ') || 'none'}`);
    log.info(`  Board: ${gameState.hand.communityCards.join(' ') || 'none'}`);
    log.info(`  Waiting for action.json ...`);

    // Attach recent hand history for Claude's context
    ctx.recentHands = getRecentHandsSummary(10);

    // Write turn.json for Claude to read
    writeJSON(TURN_FILE, ctx);

    // Start watching for action.json
    startActionWatcher();
  });

  // 5) Cards dealt
  gameState.on('cards_dealt', (cards) => {
    log.info(`My cards: ${cards.join(' ')}`);
  });

  // 6) Board updated
  gameState.on('board_updated', (board) => {
    log.info(`Board: ${board.join(' ')}`);
  });

  // 7) Showdown — immediately save hand result before new hand overwrites data
  gameState.on('showdown', (hand) => {
    log.info(`SHOWDOWN | pot=${hand.pot}`);
    const opponentCards = hand.players
      .filter(p => !p.isMe && p.cards && p.cards.length > 0)
      .map(p => ({ name: p.name, cards: p.cards }));
    if (opponentCards.length > 0) {
      log.info(`Opponent cards: ${opponentCards.map(o => `${o.name}: ${o.cards.join(' ')}`).join(', ')}`);
    }
    logHistory('showdown', {
      myCards:  hand.myCards,
      board:    hand.communityCards,
      pot:      hand.pot,
      myStack:  hand.myStack,
      players:  hand.players.map(p => {
        const out = { name: p.name, stack: p.stack, folded: p.folded, isMe: p.isMe };
        if (p.cards && p.cards.length > 0) out.cards = p.cards;
        return out;
      }),
      results:  hand.results,
      actions:  hand.actions.slice(-15),
    });
    actionInProgress = false;
  });

  // 8) Action failed
  gameState.on('action_failed', (data) => {
    log.warn(`Action failed: ${JSON.stringify(data)}`);
    actionInProgress = false;
  });

  // 9) New hand
  gameState.on('new_hand', () => {
    actionInProgress = false;
  });

  // 10) Connection events
  client.on('sio_connected', () => {
    log.info('Socket.IO namespace connected');
    // Always start action watcher on connect
    startActionWatcher();
    // Auto sit-back after reconnect, then request seat if needed
    setTimeout(async () => {
      log.info('Sending SIT_BACK to ensure we are seated...');
      client.sendPokerAction('PLAYER_SIT_BACK');
      // Also request seat in case we were fully removed
      setTimeout(async () => {
        log.info(`Requesting seat ${CONFIG.seat} with stack ${CONFIG.stack}...`);
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
    log.error('Permanently disconnected from Poker Now');
    stopActionWatcher();
    process.exit(1);
  });

  // ── Action watcher ─────────────────────────────
  // Polls action.json every 500ms; when found, executes and deletes

  function startActionWatcher() {
    if (actionWatcher) return; // already watching

    log.info('Action watcher STARTED');
    actionWatcher = setInterval(() => {
      // Debug: write a tick file to prove the interval is running
      try { fs.writeFileSync(path.join(PROFILE_DIR, '.watcher_tick'), String(Date.now())); } catch {}

      const exists = fs.existsSync(ACTION_FILE);
      if (exists) {
        fs.writeFileSync(path.join(PROFILE_DIR, '.watcher_debug'), `FOUND action.json at ${Date.now()}\n`, { flag: 'a' });
      }
      if (!exists) return;

      // File exists! Read it
      let raw = '';
      try {
        raw = fs.readFileSync(ACTION_FILE, 'utf-8');
      } catch (e) {
        log.warn(`Watcher: failed to read action.json: ${e.message}`);
        return;
      }

      let action;
      try {
        action = JSON.parse(raw.trim());
      } catch (e) {
        log.warn(`Watcher: failed to parse action.json: ${e.message}, raw=${raw.substring(0, 100)}`);
        deleteFile(ACTION_FILE);
        return;
      }

      log.info(`Watcher picked up: ${JSON.stringify(action)}`);
      deleteFile(ACTION_FILE);
      executeAction(action).then(() => {
        log.info('Watcher: executeAction completed');
      }).catch(e => {
        log.error(`Watcher: executeAction error: ${e.message}`);
        actionInProgress = false;
      });
    }, 500);
  }

  function stopActionWatcher() {
    if (actionWatcher) {
      log.info('Action watcher STOPPED');
      clearInterval(actionWatcher);
      actionWatcher = null;
    }
  }

  // Valid actions and their required/optional fields
  const VALID_ACTIONS = {
    // Game actions
    fold:           { fields: [] },
    check:          { fields: [] },
    call:           { fields: [] },
    raise:          { fields: ['amount'] },
    bet:            { fields: ['amount'] },
    // Seat actions
    sit:            { fields: [], optional: ['seat', 'stack'] },
    request_seat:   { fields: [], optional: ['seat', 'stack'] },
    sit_back:       { fields: [] },
    leave_seat:     { fields: [] },
    stand_up:       { fields: [] },
    // Chat
    chat:           { fields: ['message'] },
    // Host actions
    start_game:     { fields: [] },
    stop_game:      { fields: [] },
    pause:          { fields: [] },
    resume:         { fields: [] },
    next_hand:      { fields: [] },
    approve_player: { fields: ['player_id'], optional: ['stack'] },
    remove_player:  { fields: ['player_id'] },
  };

  function validateAction(action) {
    if (!action || typeof action !== 'object') {
      return 'Action must be a JSON object';
    }
    const act = (action.action || action.act || '').toLowerCase();
    if (!act) {
      return 'Missing "action" field';
    }
    const spec = VALID_ACTIONS[act];
    if (!spec) {
      return `Unknown action "${act}". Valid: ${Object.keys(VALID_ACTIONS).join(', ')}`;
    }
    for (const f of spec.fields) {
      // Allow player_id or playerId
      const val = action[f] || action[f.replace('_', 'Id').replace('player_id', 'playerId')];
      if (val === undefined || val === null || val === '') {
        return `Action "${act}" requires field "${f}"`;
      }
    }
    if (act === 'raise' || act === 'bet') {
      const amt = parseInt(action.amount);
      if (!amt || amt <= 0) {
        return `Action "${act}" requires a positive "amount"`;
      }
    }
    return null; // valid
  }

  async function executeAction(action) {
    const error = validateAction(action);
    if (error) {
      log.warn(`Action validation failed: ${error} | raw: ${JSON.stringify(action)}`);
      return;
    }

    const act = (action.action || action.act || '').toLowerCase();
    const amount = action.amount ? parseInt(action.amount) : undefined;

    // Chat action doesn't count as a game action — handle separately
    if (act === 'chat') {
      const message = action.message || action.content || '';
      if (!message) {
        log.warn('Chat action with no message, ignoring');
        return;
      }
      log.info(`>>> Chat: "${message}"`);
      const sent = client.sendChat(message);
      log.info(`Chat send result: ${sent ? 'OK' : 'FAILED'}`);
      logHistory('chat', { message, sent });
      return;
    }

    // Host actions — don't block normal game flow
    if (['start_game', 'stop_game', 'pause', 'resume', 'next_hand', 'approve_player', 'remove_player'].includes(act)) {
      let sent = false;
      const pid = action.player_id || action.playerId || '';
      switch (act) {
        case 'start_game':    sent = await client.startGame(); break;
        case 'stop_game':     sent = client.stopGame(); break;
        case 'pause':         sent = client.pauseGame(); break;
        case 'resume':        sent = client.resumeGame(); break;
        case 'next_hand':     sent = client.startNextHand(); break;
        case 'approve_player': sent = await client.approvePlayer(pid, action.stack || 1000); break;
        case 'remove_player':  sent = await client.removePlayer(pid); break;
      }
      log.info(`>>> Host action: ${act}${pid ? ' player=' + pid : ''} → ${sent ? 'OK' : 'FAILED'}`);
      logHistory('host_action', { action: act, playerId: pid || null, sent });
      return;
    }

    // Non-game actions — send directly, don't block watcher
    if (act === 'stand_up' || act === 'leave_seat') {
      // Leave seat = QNH (queue next hand to leave)
      const sent = client.emitEvent('action', { type: 'QNH' });
      log.info(`>>> leave_seat (QNH) → ${sent ? 'OK' : 'FAILED'}`);
      logHistory('action', { action: 'leave_seat', sent });
      return;
    }
    if (act === 'sit_back') {
      const sent = client.sendPokerAction('PLAYER_SIT_BACK');
      log.info(`>>> sit_back → ${sent ? 'OK' : 'FAILED'}`);
      logHistory('action', { action: 'sit_back', sent });
      return;
    }
    if (act === 'sit' || act === 'request_seat') {
      const seat = action.seat || CONFIG.seat;
      const stack = action.stack || CONFIG.stack;
      log.info(`>>> Requesting seat ${seat} with stack ${stack}...`);
      try {
        await client.requestSeat(seat, stack);
        log.info('Seat request sent (needs host approval)');
      } catch (e) {
        log.warn(`Seat request failed: ${e.message}`);
      }
      logHistory('action', { action: 'request_seat', seat, stack });
      return;
    }

    actionInProgress = true;

    log.info(`>>> Executing: ${act}${amount ? ' $' + amount : ''}`);

    let sent = false;
    switch (act) {
      case 'fold':    sent = client.fold(); break;
      case 'check':   sent = client.check(); break;
      case 'call':    sent = client.call(); break;
      case 'raise':
      case 'bet':     sent = client.raise(amount || 0); break;
      default:
        log.warn(`Unknown action "${act}", sending as raw: PLAYER_${act.toUpperCase()}`);
        sent = client.sendPokerAction(`PLAYER_${act.toUpperCase()}`);
    }

    log.info(`Send result: ${sent ? 'OK' : 'FAILED'}`);

    // Log to history
    logHistory('action', {
      action: act,
      amount: amount || null,
      sent,
    });

    // Clean up turn file after acting
    deleteFile(TURN_FILE);

    // Allow next turn after a brief delay
    setTimeout(() => {
      actionInProgress = false;
    }, 1000);
  }

  // ── Connect! ───────────────────────────────────
  try {
    log.info(`Connecting to: ${CONFIG.gameUrl}`);
    await client.connect();
    log.info('WebSocket connected! Listening for game events...');

    // Auto-request seat if --seat flag is passed
    if (process.argv.includes('--seat')) {
      log.info(`Requesting seat ${CONFIG.seat} with stack ${CONFIG.stack}...`);
      setTimeout(async () => {
        await client.requestSeat(CONFIG.seat, CONFIG.stack);
      }, 2000);
    }

    console.log(`
  LIVE MODE — ARIA is at the table
  Bot name: ${CONFIG.botName}
  PID: ${process.pid}

  How it works:
  1. This script stays connected to Poker Now
  2. When it's your turn → writes turn.json
  3. Claude reads turn.json, decides, writes action.json
  4. This script reads action.json → executes → deletes

  Press Ctrl+C to stop.
`);

  } catch (e) {
    log.error(`Connection failed: ${e.message}`);
    deleteFile(PID_FILE);
    process.exit(1);
  }

  // ── Graceful shutdown ──────────────────────────
  function cleanup() {
    log.info('Shutting down ARIA...');
    stopActionWatcher();

    // Delete ephemeral files — history.jsonl is intentionally kept for review
    deleteFile(TURN_FILE);
    deleteFile(ACTION_FILE);
    deleteFile(STATE_FILE);
    deleteFile(PID_FILE);

    // Clean up debug files
    deleteFile(path.join(PROFILE_DIR, '.watcher_tick'));
    deleteFile(path.join(PROFILE_DIR, '.watcher_debug'));

    client.disconnect();
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// ── GO! ──────────────────────────────────────────
main().catch(e => {
  log.error(`Fatal: ${e.message}`);
  // Best-effort cleanup on crash
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(STATE_FILE); } catch {}
  try { fs.unlinkSync(TURN_FILE); } catch {}
  try { fs.unlinkSync(ACTION_FILE); } catch {}
  process.exit(1);
});