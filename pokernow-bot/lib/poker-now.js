// src/poker-now.js — Poker Now WebSocket Client (v2)
// Correct protocol: Engine.IO v3 + Socket.IO over WebSocket
// Discovered via webpack bundle analysis of pokernow.com

const WebSocket = require('ws');
const fetch     = require('node-fetch');
const fs        = require('fs');
const path      = require('path');
const { EventEmitter } = require('events');

const BASE_URL = 'https://www.pokernow.com';

class PokerNowClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.gameUrl      - Full Poker Now game URL
   * @param {string} [opts.botName]    - Display name at the table (default: 'ARIA_Bot')
   * @param {object} [opts.logger]     - Logger with .info/.warn/.error (default: console)
   * @param {string} [opts.workDir]    - Base directory (default: project root, i.e. pokernow-bot/)
   * @param {string} [opts.profileDir] - Bot profile directory; overrides auto-detection.
   *                                     When omitted, defaults to `{workDir}/bot_profiles/{botName}/`
   *                                     Each bot gets its own dir for cookies, state, history, etc.
   * @param {string} [opts.cookieFile] - Explicit cookie file path; overrides profileDir-based default.
   */
  constructor({ gameUrl, botName = 'ARIA_Bot', logger, workDir, profileDir, cookieFile }) {
    super();
    this.gameUrl  = gameUrl;
    this.gameId   = this._extractGameId(gameUrl);
    this.botName  = botName;
    this.log      = logger || console;
    this.workDir  = workDir || path.join(__dirname, '..', '..');  // default: PokerBot/

    // Bot profile directory: explicit > auto (PokerBot/bot_profiles/{botName}/)
    this.profileDir = profileDir || path.join(this.workDir, 'bot_profiles', botName);

    // Ensure profile directory exists
    if (!fs.existsSync(this.profileDir)) {
      fs.mkdirSync(this.profileDir, { recursive: true });
    }

    // Cookie file: explicit > profile dir default
    this.cookieFile = cookieFile || path.join(this.profileDir, '.cookies');

    this.ws       = null;
    this.cookies  = this._loadCookies();
    this.sid      = '';
    this.playerId = '';       // Our unique player ID (assigned by server)
    this.pingTimer   = null;
    this.pingInterval = 20000; // Default 20s, updated from server handshake
    this.connected   = false;
    this.reconnects  = 0;
    this.maxReconnects = 10;
  }

  // ── Extract game ID from URL ───────────────────
  _extractGameId(url) {
    // https://www.pokernow.com/games/pglqMUIc51jSGK-e2H34eGUfv
    const m = url.match(/\/games\/([a-zA-Z0-9_-]+)/);
    if (!m) throw new Error(`Cannot extract game ID from: ${url}`);
    return m[1];
  }

  // ── Cookie persistence ─────────────────────────
  _loadCookies() {
    try {
      if (fs.existsSync(this.cookieFile)) {
        const cookies = fs.readFileSync(this.cookieFile, 'utf-8').trim();
        if (cookies) {
          this.log?.info?.(`[PN] Loaded saved cookies (${cookies.length} chars)`);
          return cookies;
        }
      }
    } catch {}
    return '';
  }

  _saveCookies() {
    try {
      fs.writeFileSync(this.cookieFile, this.cookies);
      this.log.info?.('[PN] Cookies saved to disk');
    } catch (e) {
      this.log.warn?.(`[PN] Failed to save cookies: ${e.message}`);
    }
  }

  // ── Step 1: Get session cookies ────────────────
  async _acquireSession() {
    this.log.info?.('[PN] Acquiring session cookie...');

    const res = await fetch(`${BASE_URL}/games/${this.gameId}`, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    const setCookies = res.headers.raw()['set-cookie'] || [];
    this.cookies = setCookies
      .map(c => c.split(';')[0])
      .join('; ');

    this.log.info?.(`[PN] Got cookies (${this.cookies.length} chars)`);
    this._saveCookies();
    return this.cookies;
  }

  // ── Step 2: Connect WebSocket ──────────────────
  async connect() {
    if (!this.cookies) {
      await this._acquireSession();
    }

    const wsUrl = this._buildWsUrl();
    this.log.info?.(`[PN] Connecting WebSocket...`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Cookie':     this.cookies,
          'Origin':     BASE_URL,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        perMessageDeflate: false,
      });

      this.ws.on('open', () => {
        this.log.info?.('[PN] WebSocket connected!');
        this.connected  = true;
        this.reconnects = 0;
        resolve();
      });

      this.ws.on('message', (data) => {
        const raw = data.toString();
        this.log.info?.(`[PN] ← RAW: ${raw.substring(0, 200)}`);
        this._onMessage(raw);
      });

      this.ws.on('close', (code, reason) => {
        this.log.warn?.(`[PN] WebSocket closed: code=${code}, reason=${reason || 'none'}`);
        this.connected = false;
        this._stopPing();
        this._maybeReconnect();
      });

      this.ws.on('error', (err) => {
        this.log.error?.(`[PN] WebSocket error: ${err.message}`);
        if (!this.connected) reject(err);
      });

      setTimeout(() => {
        if (!this.connected) {
          if (this.ws) this.ws.terminate();
          reject(new Error('Connection timeout (15s)'));
        }
      }, 15000);
    });
  }

  _buildWsUrl() {
    // Poker Now uses Engine.IO v3 (EIO=3)
    // Game ID and layout are passed as query params
    return `wss://www.pokernow.com/socket.io/?gameID=${this.gameId}&=true&layout=d&EIO=3&transport=websocket`;
  }

  // ══════════════════════════════════════════════════
  // ENGINE.IO v3 + SOCKET.IO PROTOCOL
  // ══════════════════════════════════════════════════
  //
  // Engine.IO v3 packet types:
  //   0 = open      (server sends {sid, pingInterval, pingTimeout})
  //   1 = close
  //   2 = ping      (CLIENT sends to server)
  //   3 = pong      (SERVER responds)
  //   4 = message   (contains Socket.IO packet)
  //   5 = upgrade
  //   6 = noop
  //
  // Socket.IO packet types (inside EIO message):
  //   0 = CONNECT
  //   1 = DISCONNECT
  //   2 = EVENT       → 42["eventName", data]
  //   3 = ACK
  //   4 = ERROR
  //
  // Combined: game events arrive as "42[...]"
  //   - 42["change", {...gameState...}]    — game state update
  //   - 42["gC", {...}]                    — game clock sync
  //   - 42["registered", {...}]            — initial full state
  //   - 42["rup", {...}]                   — round update
  //
  // Actions sent as: 42["action", {type:"updateIntendedAction", kind:"PLAYER_FOLD"}]

  _onMessage(raw) {
    this.emit('raw', raw);

    if (!raw || raw.length === 0) return;
    const eioType = raw[0];

    switch (eioType) {
      case '0': { // EIO open — server handshake
        try {
          const info = JSON.parse(raw.substring(1));
          this.sid = info.sid || this.sid;
          if (info.pingInterval) this.pingInterval = info.pingInterval;
          if (info.pingTimeout)  this.pingTimeout  = info.pingTimeout;
          this.log.info?.(`[PN] EIO open: sid=${this.sid}, pingInterval=${this.pingInterval}ms, pingTimeout=${this.pingTimeout || 'N/A'}ms`);
          this.log.info?.(`[PN] Handshake full: ${JSON.stringify(info)}`);
          this._startPing(this.pingInterval);
          // Send Socket.IO CONNECT to default namespace
          this.send('40');
          this.log.info?.('[PN] → Sent SIO CONNECT (40)');
        } catch (e) { /* ignore */ }
        break;
      }

      case '2': // EIO ping from server (server-initiated ping, reply with pong)
        this.log.debug?.('[PN] Got server ping, sending pong');
        this.send('3');
        break;

      case '3': // EIO pong (response to our ping)
        this.log.debug?.('[PN] Got pong');
        break;

      case '4': // Socket.IO message
        this._handleSIOPacket(raw.substring(1));
        break;

      case '1': // EIO close
        this.log.warn?.('[PN] Server sent close');
        break;

      default:
        this.log.debug?.(`[PN] Unknown EIO type: ${eioType}`);
    }
  }

  _handleSIOPacket(data) {
    if (!data || data.length === 0) return;
    const sioType = data[0];

    switch (sioType) {
      case '0': // SIO CONNECT ack
        this.log.info?.('[PN] Socket.IO namespace connected');
        this.emit('sio_connected');
        break;

      case '2': { // SIO EVENT — the main one
        this._parseSIOEvent(data.substring(1));
        break;
      }

      case '3': { // SIO ACK
        this.log.debug?.(`[PN] ACK: ${data.substring(0, 80)}`);
        break;
      }

      case '4': // SIO ERROR
        this.log.error?.(`[PN] SIO Error: ${data}`);
        break;

      default:
        this.log.debug?.(`[PN] SIO type ${sioType}: ${data.substring(0, 100)}`);
    }
  }

  _parseSIOEvent(data) {
    // Format: [optional_ack_id]["eventName", arg1, arg2, ...]
    let ackId = null;
    let jsonStr = data;

    const ackMatch = data.match(/^(\d+)(\[.+)/s);
    if (ackMatch) {
      ackId   = parseInt(ackMatch[1]);
      jsonStr = ackMatch[2];
    }

    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const eventName = parsed[0];
        const args      = parsed.slice(1);

        this.log.debug?.(`[PN] Event: "${eventName}"`);

        // Emit generic and specific events
        this.emit('game_event', eventName, args, ackId);
        this.emit(`ev:${eventName}`, ...args, ackId);

        // Handle special events
        if (eventName === 'registered') {
          this._onRegistered(args[0]);
        }
      }
    } catch (e) {
      this.log.debug?.(`[PN] Non-JSON event: ${data.substring(0, 100)}`);
    }
  }

  // ── Handle "registered" event (contains our player ID) ─
  _onRegistered(data) {
    if (data && data.currentPlayer) {
      this.playerId = data.currentPlayer.id || '';
      this.log.info?.(`[PN] Registered as player: ${this.playerId}`);
    }
    if (data && data.gameState) {
      this.log.info?.('[PN] Received initial game state');
    }
    this.emit('registered', data);
  }

  // ── Send Socket.IO event ───────────────────────
  // Poker Now uses: socket.binary(false).emit("action", payload)
  // Wire format: 42["action", payload]
  emitEvent(eventName, ...args) {
    const payload = JSON.stringify([eventName, ...args]);
    const frame = `42${payload}`;
    this.log.info?.(`[PN] → WS SEND: ${frame}`);
    return this.send(frame);
  }

  // ── Send a poker action ────────────────────────
  // Browser sends: 42["action", {"type": "PLAYER_FOLD"}]
  // For raise:     42["action", {"type": "PLAYER_RAISE", "value": 200}]
  sendPokerAction(kind, value = null) {
    const payload = { type: kind };
    if (value !== null && value !== undefined) {
      payload.value = value;
    }
    this.log.info?.(`[PN] → Poker action: ${kind}${value ? ' value=' + value : ''}`);
    // Send via Socket.IO: 42["action", payload]
    const sent = this.emitEvent('action', payload);
    if (!sent) {
      this.log.error?.(`[PN] ✗ FAILED to send action ${kind} — WebSocket not open!`);
    }
    return sent;
  }

  // ── Convenience action methods ─────────────────
  fold()  { return this.sendPokerAction('PLAYER_FOLD'); }
  check() { return this.sendPokerAction('PLAYER_CHECK'); }
  call()  { return this.sendPokerAction('PLAYER_CALL'); }
  raise(amount) { return this.sendPokerAction('PLAYER_RAISE', amount); }
  checkOrFold() { return this.sendPokerAction('CHECK_OR_FOLD'); }
  standUp()     { return this.sendPokerAction('PLAYER_STAND_UP'); }
  sitBack()     { return this.sendPokerAction('PLAYER_SIT_BACK'); }

  // ── Request seat at table (HTTP API) ───────────
  async requestSeat(seat = 5, stack = 1000) {
    this.log.info?.(`[PN] Requesting seat ${seat} with stack ${stack}...`);
    try {
      const res = await fetch(`${BASE_URL}/games/${this.gameId}/request_ingress`, {
        method: 'POST',
        headers: {
          'Cookie': this.cookies,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({
          seat,
          playerName: this.botName,
          allowSpectator: false,
          stack,
        }),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      this.log.info?.(`[PN] Seat request response: ${res.status}`);
      return data;
    } catch (e) {
      this.log.error?.(`[PN] Seat request failed: ${e.message}`);
      return null;
    }
  }

  // ── Send chat message ───────────────────────────
  // Poker Now chat: 42["new-message", "text"]
  sendChat(message) {
    this.log.info?.(`[PN] → Chat: "${message}"`);
    const sent = this.emitEvent('new-message', message);
    if (!sent) {
      this.log.error?.(`[PN] ✗ FAILED to send chat — WebSocket not open!`);
    }
    return sent;
  }

  // ══════════════════════════════════════════════════
  // HOST / ADMIN ACTIONS
  // ══════════════════════════════════════════════════
  // These require the bot's session to be the room host (game creator).
  // Protocol discovered via Chrome DevTools interception.

  // ── Start game (HTTP) ──────────────────────────
  // First game start or restart after stop — uses HTTP, not WebSocket
  async startGame() {
    this.log.info?.('[PN] → Host: Starting game (HTTP POST)...');
    try {
      const res = await fetch(`${BASE_URL}/games/${this.gameId}/start-game`, {
        method: 'POST',
        headers: {
          'Cookie': this.cookies,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const text = await res.text();
      this.log.info?.(`[PN] Start game response: ${res.status} ${text.substring(0, 100)}`);
      return res.ok;
    } catch (e) {
      this.log.error?.(`[PN] Start game failed: ${e.message}`);
      return false;
    }
  }

  // ── Start next hand (WebSocket) ────────────────
  // NH = New Hand — deals the next hand while game is running
  startNextHand() {
    this.log.info?.('[PN] → Host: New hand (NH)');
    return this.emitEvent('action', { type: 'NH', socket: true });
  }

  // ── Stop game (WebSocket) ──────────────────────
  // TSG = Toggle Stop Game — stops after current hand finishes
  stopGame() {
    this.log.info?.('[PN] → Host: Stopping game (TSG)');
    return this.emitEvent('action', { type: 'TSG', decision: true, socket: true });
  }

  // ── Pause game (WebSocket) ─────────────────────
  // UP = Unpause/Pause — pauses the current hand timer
  pauseGame() {
    this.log.info?.('[PN] → Host: Pausing game (UP)');
    return this.emitEvent('action', { type: 'UP', socket: true });
  }

  // ── Resume game (WebSocket) ────────────────────
  // UR = Unpause/Resume — resumes from pause
  resumeGame() {
    this.log.info?.('[PN] → Host: Resuming game (UR)');
    return this.emitEvent('action', { type: 'UR', socket: true });
  }

  // ── Accept player join request (HTTP) ──────────
  // Approves a pending ingress request
  async approvePlayer(playerId, stack = 1000) {
    this.log.info?.(`[PN] → Host: Approving player ${playerId} with stack ${stack}`);
    try {
      const res = await fetch(`${BASE_URL}/games/${this.gameId}/approve_player`, {
        method: 'POST',
        headers: {
          'Cookie': this.cookies,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({ playerID: playerId, stackChange: stack }),
      });
      const text = await res.text();
      this.log.info?.(`[PN] Approve player response: ${res.status} ${text.substring(0, 100)}`);
      return res.ok;
    } catch (e) {
      this.log.error?.(`[PN] Approve player failed: ${e.message}`);
      return false;
    }
  }

  // ── Remove (kick) player (HTTP) ────────────────
  // Removes a player from the table
  async removePlayer(playerId) {
    this.log.info?.(`[PN] → Host: Removing player ${playerId}`);
    try {
      const res = await fetch(`${BASE_URL}/games/${this.gameId}/remove_player`, {
        method: 'POST',
        headers: {
          'Cookie': this.cookies,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({ playerID: playerId }),
      });
      const text = await res.text();
      this.log.info?.(`[PN] Remove player response: ${res.status} ${text.substring(0, 100)}`);
      return res.ok;
    } catch (e) {
      this.log.error?.(`[PN] Remove player failed: ${e.message}`);
      return false;
    }
  }

  // ── Send raw frame ────────────────────────────
  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return true;
    }
    this.log.warn?.(`[PN] ✗ send() failed: ws=${this.ws ? 'exists' : 'null'}, readyState=${this.ws?.readyState} (need ${WebSocket.OPEN})`);
    return false;
  }

  // ── Ping keep-alive ────────────────────────────
  // In EIO v3, CLIENT sends ping (2), server responds pong (3)
  _startPing(interval = 20000) {
    this._stopPing();
    this.log.info?.(`[PN] Starting ping every ${interval}ms`);
    this.pingTimer = setInterval(() => {
      if (this.connected) {
        this.send('2');
        this.log.debug?.('[PN] Sent ping');
      }
    }, interval);
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ── Reconnect ──────────────────────────────────
  async _maybeReconnect() {
    if (this.reconnects >= this.maxReconnects) {
      this.log.error?.('[PN] Max reconnects reached.');
      this.emit('disconnected');
      return;
    }
    this.reconnects++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnects), 30000);
    this.log.info?.(`[PN] Reconnecting in ${delay}ms (attempt ${this.reconnects})...`);
    setTimeout(async () => {
      try {
        // Keep existing cookies — don't clear! Reuse identity.
        await this.connect();
      } catch (e) {
        this.log.error?.(`[PN] Reconnect failed: ${e.message}`);
      }
    }, delay);
  }

  // ── Disconnect ─────────────────────────────────
  disconnect() {
    this._stopPing();
    this.maxReconnects = 0;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

module.exports = { PokerNowClient };