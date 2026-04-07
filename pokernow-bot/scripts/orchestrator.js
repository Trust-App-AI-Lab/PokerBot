#!/usr/bin/env node
/**
 * orchestrator.js — Multi-Bot Poker Orchestrator (Robust)
 *
 * Manages N bot connections to a single Poker Now game.
 * CC writes game.json, launches this script. Orchestrator handles:
 *   - Multi-bot WebSocket management
 *   - Pending turn queue (CC watches ONE file: pending-turns.json)
 *   - Turn timeout auto-fold (CC doesn't respond → safe fallback)
 *   - Heartbeat (CC can verify orchestrator is alive)
 *   - Per-bot reconnection (one bot dies ≠ all die)
 *
 * Usage:
 *   node scripts/orchestrator.js                    # reads ../game.json
 *   node scripts/orchestrator.js --config path.json # custom config
 *
 * Stop: Ctrl+C
 */

const path = require('path');
const fs   = require('fs');
const { PokerNowClient } = require('../lib/poker-now');
const { GameState }       = require('../lib/game-state');

// ── Paths ────────────────────────────────────────
const ENGINE_DIR   = path.join(__dirname, '..');
const PROJECT_ROOT = path.join(ENGINE_DIR, '..');
const PROFILES_DIR = path.join(PROJECT_ROOT, 'bot_profiles');

// Shared files at project root — CC only needs to watch these
const PENDING_TURNS_FILE = path.join(PROJECT_ROOT, 'pending-turns.json');
const HEARTBEAT_FILE     = path.join(PROJECT_ROOT, 'orchestrator-heartbeat.json');
const ORCHESTRATOR_PID   = path.join(PROJECT_ROOT, 'orchestrator.pid');

// ── Parse args ───────────────────────────────────
const configArg = process.argv.indexOf('--config');
const CONFIG_FILE = configArg !== -1 && process.argv[configArg + 1]
  ? path.resolve(process.argv[configArg + 1])
  : path.join(PROJECT_ROOT, 'game.json');

// ── Tuning ───────────────────────────────────────
const TURN_TIMEOUT_MS      = 60000;   // 60s — auto-fold if CC doesn't respond
const HEARTBEAT_INTERVAL   = 5000;    // 5s — write heartbeat
const ACTION_POLL_INTERVAL = 500;     // 0.5s — check for action.json
const RECONNECT_DELAY_BASE = 5000;    // 5s — base reconnect delay per bot
const STAGGER_DELAY        = 3000;    // 3s — between bot connections

// ── Logger ───────────────────────────────────────
function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}
const log = {
  info:  (...a) => console.log(`[${timestamp()}] [INFO]`, ...a),
  warn:  (...a) => console.log(`[${timestamp()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${timestamp()}] [ERR]`, ...a),
  debug: () => {},
};

// ── File helpers ─────────────────────────────────
function writeJSON(filepath, data) {
  try { fs.writeFileSync(filepath, JSON.stringify(data, null, 2)); }
  catch (e) { log.error(`writeJSON failed: ${filepath} — ${e.message}`); }
}
function readJSON(filepath) {
  try {
    if (fs.existsSync(filepath)) {
      const raw = fs.readFileSync(filepath, 'utf-8').trim();
      if (raw) return JSON.parse(raw);
    }
  } catch (e) { log.error(`readJSON failed: ${filepath} — ${e.message}`); }
  return null;
}
function deleteFile(filepath) {
  try { fs.unlinkSync(filepath); } catch {}
}
function logHistory(profileDir, type, data) {
  const histFile = path.join(profileDir, 'history.jsonl');
  const record = { time: new Date().toISOString(), type, ...data };
  try { fs.appendFileSync(histFile, JSON.stringify(record) + '\n'); } catch {}
}

// ══════════════════════════════════════════════════
// PENDING TURNS QUEUE
// ══════════════════════════════════════════════════
// CC only needs to watch this ONE file to know which bots need decisions.
// Format: { "turns": [ { botName, since, timeout_at }, ... ] }
//
const pendingTurns = new Map();  // botName → { since, timeoutTimer }

function updatePendingTurnsFile() {
  const turns = [];
  for (const [botName, info] of pendingTurns) {
    turns.push({
      botName,
      since:      new Date(info.since).toISOString(),
      timeout_at: new Date(info.since + TURN_TIMEOUT_MS).toISOString(),
      seconds_left: Math.max(0, Math.round((info.since + TURN_TIMEOUT_MS - Date.now()) / 1000)),
    });
  }
  writeJSON(PENDING_TURNS_FILE, {
    count: turns.length,
    turns,
    updated: new Date().toISOString(),
  });
}

function addPendingTurn(botName, botInstance) {
  // Clear existing timeout if re-triggered
  if (pendingTurns.has(botName)) {
    clearTimeout(pendingTurns.get(botName).timeoutTimer);
  }

  const since = Date.now();
  // Flag to prevent timeout firing after action was already taken (race condition)
  const turnCtx = { actionTaken: false };

  const timeoutTimer = setTimeout(() => {
    // ── TURN TIMEOUT: auto-fold ──
    if (turnCtx.actionTaken) return;  // Action watcher already handled this turn
    turnCtx.actionTaken = true;

    log.warn(`[${botName}] ⏰ Turn timeout (${TURN_TIMEOUT_MS / 1000}s) — auto-checking/folding`);

    // Guard: client may be null during reconnection
    let sent = false;
    if (botInstance.client) {
      sent = botInstance.client.check();
      if (!sent) sent = botInstance.client.fold();
    }

    logHistory(botInstance.profileDir, 'timeout_action', {
      action: sent ? 'auto_check_or_fold' : 'timeout_send_failed',
    });

    deleteFile(botInstance.files.turn);
    botInstance.actionInProgress = false;
    pendingTurns.delete(botName);
    updatePendingTurnsFile();
  }, TURN_TIMEOUT_MS);

  pendingTurns.set(botName, { since, timeoutTimer, turnCtx });
  updatePendingTurnsFile();
}

function removePendingTurn(botName) {
  if (pendingTurns.has(botName)) {
    const entry = pendingTurns.get(botName);
    entry.turnCtx.actionTaken = true;  // Prevent timeout from firing
    clearTimeout(entry.timeoutTimer);
    pendingTurns.delete(botName);
    updatePendingTurnsFile();
  }
}

// ══════════════════════════════════════════════════
// HEARTBEAT
// ══════════════════════════════════════════════════
// CC can check this file to verify orchestrator is alive.
// If file is stale (>15s old), orchestrator is dead.

let heartbeatTimer = null;
function startHeartbeat(instances) {
  heartbeatTimer = setInterval(() => {
    const botStatus = {};
    for (const bot of instances) {
      botStatus[bot.botName] = {
        connected:        bot.connected,
        actionInProgress: bot.actionInProgress,
        hasPendingTurn:   pendingTurns.has(bot.botName),
        reconnects:       bot.reconnectCount || 0,
      };
    }
    writeJSON(HEARTBEAT_FILE, {
      alive: true,
      pid:   process.pid,
      uptime_s: Math.round(process.uptime()),
      bots: botStatus,
      pending_turns: pendingTurns.size,
      timestamp: new Date().toISOString(),
    });
  }, HEARTBEAT_INTERVAL);
}

// ══════════════════════════════════════════════════
// BOT INSTANCE
// ══════════════════════════════════════════════════
class BotInstance {
  constructor(botName, gameUrl, opts = {}) {
    this.botName    = botName;
    this.profileDir = path.join(PROFILES_DIR, botName);
    this.gameUrl    = gameUrl;
    this.autoSeat   = opts.autoSeat ?? true;
    this.stack      = opts.stack || 1000;
    // Note: CoachBot no longer connects through orchestrator (uses browser bridge instead)

    if (!fs.existsSync(this.profileDir)) {
      fs.mkdirSync(this.profileDir, { recursive: true });
    }

    this.files = {
      turn:   path.join(this.profileDir, 'turn.json'),
      action: path.join(this.profileDir, 'action.json'),
      state:  path.join(this.profileDir, 'state.json'),
      pid:    path.join(this.profileDir, 'bridge.pid'),
    };

    this.client    = null;  // Created in connect()
    this.gameState = null;
    this.lastPhase       = '';
    this.actionInProgress = false;
    this.actionWatcher    = null;
    this.connected        = false;
    this.reconnectCount   = 0;
    this.maxReconnects    = 20;
    this._reconnecting    = false;
  }

  _makeLogger() {
    const tag = `[${this.botName}]`;
    return {
      info:  (...a) => log.info(tag, ...a),
      warn:  (...a) => log.warn(tag, ...a),
      error: (...a) => log.error(tag, ...a),
      debug: () => {},
    };
  }

  // ── Create fresh client + game state ──────────
  _createClient() {
    this.client = new PokerNowClient({
      gameUrl:    this.gameUrl,
      botName:    this.botName,
      logger:     this._makeLogger(),
      workDir:    PROJECT_ROOT,
      profileDir: this.profileDir,
    });
    this.gameState = new GameState({
      botName: this.botName,
      logger:  this._makeLogger(),
    });
  }

  // ── Wire events ───────────────────────────────
  _wireEvents() {
    const { client, gameState } = this;

    client.on('game_event', (eventName, args) => {
      gameState.processEvent(eventName, args);
    });

    client.on('registered', (data) => {
      if (data?.currentPlayer) {
        gameState.playerId = data.currentPlayer.id;
        log.info(`[${this.botName}] Registered: ${data.currentPlayer.id}`);
      }
    });

    // State updated
    gameState.on('state_updated', (hand) => {
      const ctx = gameState.getClaudeContext();
      ctx.playerId  = gameState.playerId;
      ctx.timestamp = Date.now();
      ctx.isMyTurn  = !!hand.isMyTurn;
      ctx.botName   = this.botName;
      writeJSON(this.files.state, ctx);

      const phase = hand.phase;

      if (phase === 'preflop' && this.lastPhase !== 'preflop') {
        log.info(`[${this.botName}] ═══ NEW HAND ═══`);
        this.actionInProgress = false;
        logHistory(this.profileDir, 'hand_start', {
          myCards: hand.myCards, myStack: hand.myStack,
          players: hand.players.map(p => ({ name: p.name, stack: p.stack, isMe: p.isMe })),
          bigBlind: hand.bigBlind,
        });
      }

      if ((phase === 'showdown' || phase === 'waiting') &&
          this.lastPhase !== 'showdown' && this.lastPhase !== 'waiting' && this.lastPhase !== '') {
        logHistory(this.profileDir, 'hand_end', {
          myCards: hand.myCards, board: hand.communityCards,
          pot: hand.pot, myStack: hand.myStack, results: hand.results,
        });
        deleteFile(this.files.turn);
        removePendingTurn(this.botName);
        this._stopActionWatcher();
        this.actionInProgress = false;
      }

      this.lastPhase = phase;
    });

    // My turn
    gameState.on('my_turn', (turnInfo) => {
      if (this.actionInProgress) return;

      const ctx = gameState.getClaudeContext();
      ctx.playerId  = gameState.playerId;
      ctx.isMyTurn  = true;
      ctx.turnInfo  = turnInfo;
      ctx.timestamp = Date.now();
      ctx.botName   = this.botName;

      log.info(`[${this.botName}] ★ MY TURN | call=$${turnInfo.callAmount} pot=$${turnInfo.pot}`);
      writeJSON(this.files.turn, ctx);

      addPendingTurn(this.botName, this);
      this._startActionWatcher();
    });

    gameState.on('showdown', () => { this.actionInProgress = false; });
    gameState.on('action_failed', () => { this.actionInProgress = false; });
    gameState.on('new_hand', () => { this.actionInProgress = false; });

    // Connection events
    client.on('sio_connected', () => {
      log.info(`[${this.botName}] Socket.IO connected`);
      this.connected = true;
      setTimeout(() => client.sendPokerAction('PLAYER_SIT_BACK'), 2000);
    });

    // ── Per-bot reconnection ─────────────────────
    // Override default disconnect behavior: don't exit process,
    // just reconnect this one bot independently.
    client.on('disconnected', () => {
      log.error(`[${this.botName}] Disconnected from Poker Now`);
      this.connected = false;
      this._stopActionWatcher();
      removePendingTurn(this.botName);
      this._scheduleReconnect();
    });
  }

  // ── Reconnect logic (per-bot, doesn't affect others) ──
  async _scheduleReconnect() {
    if (this._reconnecting) return;
    if (this.reconnectCount >= this.maxReconnects) {
      log.error(`[${this.botName}] Max reconnects (${this.maxReconnects}) reached. Giving up.`);
      return;
    }

    this._reconnecting = true;
    this.reconnectCount++;
    const delay = Math.min(RECONNECT_DELAY_BASE * Math.pow(1.5, this.reconnectCount - 1), 60000);
    log.info(`[${this.botName}] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectCount})...`);

    await new Promise(r => setTimeout(r, delay));

    try {
      this._createClient();
      this._wireEvents();
      await this.client.connect();
      this.connected = true;
      this.reconnectCount = 0;  // Reset on success
      log.info(`[${this.botName}] ✓ Reconnected!`);

      if (this.autoSeat) {
        setTimeout(() => this.client.requestSeat(0, this.stack), 2000);
      }
    } catch (e) {
      log.error(`[${this.botName}] Reconnect failed: ${e.message}`);
      this.connected = false;
    }
    this._reconnecting = false;

    // If still not connected, schedule another attempt
    if (!this.connected && this.reconnectCount < this.maxReconnects) {
      this._scheduleReconnect();
    }
  }

  // ── Action watcher ────────────────────────────
  _startActionWatcher() {
    if (this.actionWatcher) return;
    this.actionWatcher = setInterval(() => {
      if (!fs.existsSync(this.files.action)) return;

      let raw, action;
      try {
        raw = fs.readFileSync(this.files.action, 'utf-8');
        action = JSON.parse(raw.trim());
      } catch {
        deleteFile(this.files.action);
        return;
      }

      log.info(`[${this.botName}] ◆ Action: ${JSON.stringify(action)}`);
      deleteFile(this.files.action);

      // Cancel turn timeout — CC responded in time
      removePendingTurn(this.botName);

      this._executeAction(action).catch(e => {
        log.error(`[${this.botName}] Action error: ${e.message}`);
        this.actionInProgress = false;
      });
    }, ACTION_POLL_INTERVAL);
  }

  _stopActionWatcher() {
    if (this.actionWatcher) {
      clearInterval(this.actionWatcher);
      this.actionWatcher = null;
    }
  }

  // ── Execute action ────────────────────────────
  async _executeAction(action) {
    const act    = (action.action || action.act || '').toLowerCase();
    const amount = action.amount ? parseInt(action.amount, 10) : undefined;
    if (!act) return;

    // Chat
    if (act === 'chat') {
      const msg = action.message || action.content || '';
      if (msg) this.client.sendChat(msg);
      logHistory(this.profileDir, 'chat', { message: msg });
      return;
    }

    // Host actions
    if (['start_game', 'stop_game', 'pause', 'resume', 'next_hand',
         'approve_player', 'remove_player'].includes(act)) {
      let sent = false;
      const pid = action.player_id || action.playerId || '';
      switch (act) {
        case 'start_game':     sent = await this.client.startGame(); break;
        case 'stop_game':      sent = this.client.stopGame(); break;
        case 'pause':          sent = this.client.pauseGame(); break;
        case 'resume':         sent = this.client.resumeGame(); break;
        case 'next_hand':      sent = this.client.startNextHand(); break;
        case 'approve_player': sent = await this.client.approvePlayer(pid, action.stack || this.stack); break;
        case 'remove_player':  sent = await this.client.removePlayer(pid); break;
      }
      log.info(`[${this.botName}] Host: ${act} → ${sent ? 'OK' : 'FAIL'}`);
      logHistory(this.profileDir, 'host_action', { action: act, sent });
      return;
    }

    // Game actions
    this.actionInProgress = true;
    let sent = false;
    switch (act) {
      case 'fold':              sent = this.client.fold(); break;
      case 'check':             sent = this.client.check(); break;
      case 'call':              sent = this.client.call(); break;
      case 'raise': case 'bet': sent = this.client.raise(amount || 0); break;
      default:                  sent = this.client.sendPokerAction(`PLAYER_${act.toUpperCase()}`);
    }

    log.info(`[${this.botName}] → ${act}${amount ? ' $' + amount : ''}: ${sent ? 'OK' : 'FAIL'}`);
    logHistory(this.profileDir, 'action', { action: act, amount: amount || null, sent });
    deleteFile(this.files.turn);
    setTimeout(() => { this.actionInProgress = false; }, 1000);
  }

  // ── Connect ───────────────────────────────────
  async connect() {
    // Kill any legacy bridge-live.js running for this bot
    if (fs.existsSync(this.files.pid)) {
      try {
        const oldPid = parseInt(fs.readFileSync(this.files.pid, 'utf-8').trim(), 10);
        if (oldPid && oldPid !== process.pid) {
          try {
            process.kill(oldPid, 0);
            log.warn(`[${this.botName}] Killing legacy bridge process (PID ${oldPid})...`);
            process.kill(oldPid, 'SIGTERM');
            const start = Date.now();
            while (Date.now() - start < 2000) {
              try { process.kill(oldPid, 0); } catch { break; }
            }
          } catch {}
        }
      } catch {}
    }

    this._createClient();
    this._wireEvents();

    // Override client's built-in reconnect — we handle it ourselves
    this.client.maxReconnects = 0;

    deleteFile(this.files.turn);
    deleteFile(this.files.action);
    deleteFile(this.files.state);

    log.info(`[${this.botName}] Connecting...`);
    await this.client.connect();
    this.connected = true;
    log.info(`[${this.botName}] ✓ Connected`);

    if (this.autoSeat) {
      log.info(`[${this.botName}] Requesting seat (stack=${this.stack})...`);
      setTimeout(() => this.client.requestSeat(0, this.stack), 2000);
    }
  }

  // ── Cleanup ───────────────────────────────────
  cleanup() {
    this._stopActionWatcher();
    removePendingTurn(this.botName);
    deleteFile(this.files.turn);
    deleteFile(this.files.action);
    deleteFile(this.files.state);
    deleteFile(this.files.pid);
    if (this.client) this.client.disconnect();
    log.info(`[${this.botName}] Cleaned up`);
  }
}

// ══════════════════════════════════════════════════
// KILL OLD ORCHESTRATOR
// ══════════════════════════════════════════════════
(function killOldOrchestrator() {
  try {
    if (fs.existsSync(ORCHESTRATOR_PID)) {
      const oldPid = parseInt(fs.readFileSync(ORCHESTRATOR_PID, 'utf-8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
          console.log(`[INIT] Killing old orchestrator (PID ${oldPid})...`);
          process.kill(oldPid, 'SIGTERM');
          const start = Date.now();
          while (Date.now() - start < 3000) {
            try { process.kill(oldPid, 0); } catch { break; }
          }
        } catch {}
      }
    }
  } catch {}
  fs.writeFileSync(ORCHESTRATOR_PID, String(process.pid));
})();

// ══════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════
async function main() {
  if (!fs.existsSync(CONFIG_FILE)) {
    log.error(`No game config: ${CONFIG_FILE}`);
    log.error('CC should write game.json first. Example:');
    log.error('  { "gameUrl": "https://pokernow.com/games/xxx", "bots": ["Shark_Alice"] }');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  const { gameUrl, bots, autoSeat = true, stack = 1000 } = config;

  if (!gameUrl || !bots || bots.length === 0) {
    log.error('game.json must have "gameUrl" and non-empty "bots" array');
    process.exit(1);
  }

  console.log(`
+═══════════════════════════════════════════════════════+
|  POKER ORCHESTRATOR — Multi-Bot Manager (Robust)      |
|  Game:  ${gameUrl.substring(0, 50).padEnd(50)} |
|  Bots:  ${bots.join(', ').substring(0, 50).padEnd(50)} |
|  Timeout: ${TURN_TIMEOUT_MS / 1000}s auto-fold | Heartbeat: ${HEARTBEAT_INTERVAL / 1000}s       |
+═══════════════════════════════════════════════════════+
`);

  // ── Create + connect bots ─────────────────────
  const instances = [];
  for (const botName of bots) {
    instances.push(new BotInstance(botName, gameUrl, {
      autoSeat, stack,
    }));
  }

  // Note: CoachBot connects via browser bridge (coach-bridge.js), not through orchestrator

  for (let i = 0; i < instances.length; i++) {
    const bot = instances[i];
    try {
      await bot.connect();
      fs.writeFileSync(bot.files.pid, String(process.pid));
    } catch (e) {
      log.error(`[${bot.botName}] Connect failed: ${e.message}`);
      // Don't exit — other bots may succeed. This bot will try to reconnect.
      bot._scheduleReconnect();
    }
    if (i < instances.length - 1) {
      log.info(`Waiting ${STAGGER_DELAY / 1000}s before next bot...`);
      await new Promise(r => setTimeout(r, STAGGER_DELAY));
    }
  }

  const connected = instances.filter(b => b.connected);
  log.info(`═══ ${connected.length}/${instances.length} bots connected ═══`);

  // Start heartbeat
  startHeartbeat(instances);

  console.log(`
  ORCHESTRATOR RUNNING (PID ${process.pid})
  ${connected.length} bots connected.

  CC watches: pending-turns.json (who needs a decision?)
  CC checks:  orchestrator-heartbeat.json (am I alive?)

  Robustness:
  - Turn timeout: ${TURN_TIMEOUT_MS / 1000}s → auto check/fold
  - Bot disconnect: auto-reconnect (up to ${instances[0]?.maxReconnects || 20} attempts)
  - Heartbeat: every ${HEARTBEAT_INTERVAL / 1000}s

  Press Ctrl+C to stop (or delete game.json).
`);

  // ── Graceful shutdown ──────────────────────────
  let gameJsonWatcher = null;
  let isShuttingDown = false;

  function cleanup() {
    if (isShuttingDown) return;  // prevent double-cleanup from SIGTERM + gameJsonWatcher race
    isShuttingDown = true;

    log.info('Shutting down all bots...');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (gameJsonWatcher) clearInterval(gameJsonWatcher);

    for (const bot of instances) {
      try { bot.cleanup(); } catch {}
    }

    // Clean shared files
    deleteFile(PENDING_TURNS_FILE);
    deleteFile(HEARTBEAT_FILE);
    deleteFile(ORCHESTRATOR_PID);
    deleteFile(CONFIG_FILE);
    process.exit(0);
  }

  // ── Watch for game.json deletion (= game end signal from CC) ──
  gameJsonWatcher = setInterval(() => {
    if (!fs.existsSync(CONFIG_FILE)) {
      log.warn('game.json was deleted — CC signaled game end. Shutting down gracefully.');
      cleanup();
    }
  }, 2000);  // check every 2s

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch(e => {
  log.error(`Fatal: ${e.message}`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  deleteFile(ORCHESTRATOR_PID);
  deleteFile(PENDING_TURNS_FILE);
  deleteFile(HEARTBEAT_FILE);
  process.exit(1);
});
