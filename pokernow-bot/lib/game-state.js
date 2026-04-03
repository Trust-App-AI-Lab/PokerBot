// src/game-state.js — Poker Now Game State Parser (v2)
// Parses real Poker Now Socket.IO events into clean game state
//
// Key Poker Now events:
//   "change"      — game state update (partial or full frame)
//   "registered"  — initial connection with full state + player ID
//   "gC"          — game clock sync
//   "rup"         — round update / new hand prompt
//   "nEM"         — new event message
//   "rEM"         — remove event message
//   "GAME:TO_CLIENT" — game-level notifications
//   "failed"      — action failure
//
// Game state lives in currentFrame with fields:
//   status, gM (game mode: "th"), pot, bigBlind, smallBlind,
//   pC (cards by player/position), players, seats, dealerSeat,
//   eventsData, mode, ownerID, etc.
//
// Player fields: id, name, status, gameStatus, currentBet,
//   winCount, quitCount, actionStartedAt, usingTimeBank, etc.
//
// gameStatus values: "inGame", "fold", "check", "allIn", etc.
// status values: "watching", "inGame", "requestedGameIngress", etc.
//
// Card format: suit letters h/c/d/s, ranks 2-9,T,J,Q,K,A
//   e.g. "Ah" = Ace of hearts, "Ts" = Ten of spades

const { EventEmitter } = require('events');

class GameState extends EventEmitter {
  constructor({ playerId = '', botName = '', logger }) {
    super();
    this.log = logger || console;
    this.playerId = playerId;   // Set from "registered" event
    this.botName  = botName;
    this.frame    = null;       // Raw currentFrame from server
    this.reset();
  }

  reset() {
    this.hand = {
      phase:          'waiting',     // waiting | preflop | flop | turn | river | showdown
      myCards:        [],            // ['Ah', 'Kd']
      communityCards: [],            // ['Qc', '7s', '2h', ...]
      pot:            0,
      myStack:        0,
      mySeat:         null,
      myName:         '',
      myId:           '',
      dealer:         null,
      smallBlind:     0,
      bigBlind:       0,
      currentBet:     0,
      myBetThisRound: 0,
      isMyTurn:       false,
      callAmount:     0,
      minRaise:       0,
      maxRaise:       0,
      players:        [],            // [{id, seat, name, stack, bet, folded, status, cards}]
      actions:        [],            // [{actor, action, amount, phase}] FULL hand history (accumulated)
      _actionKeys:    new Set(),     // dedup keys for accumulated actions
      results:        [],            // [{winner, amount}] from showdown
      handNumber:     0,
    };
  }

  // ── Main event dispatcher ──────────────────────
  processEvent(eventName, args) {
    const data = args[0];

    switch (eventName) {
      case 'change':
        this._handleChange(data);
        break;

      case 'registered':
        this._handleRegistered(data);
        break;

      case 'gC':
        // Game clock events ALSO carry game state updates (pITT, pGS, pC, tB, etc.)
        // Must be processed like change events to detect turns and update state
        this._handleChange(data);
        break;

      case 'rup':
        // Round update — may signal new hand available
        this.log.debug?.('[GS] Round update');
        this.emit('round_update', data);
        break;

      case 'nEM':
        // New event message (chat, system notifications)
        this._handleEventMessage(data);
        break;

      case 'rEM':
        // Remove event message
        break;

      case 'GAME:TO_CLIENT':
        this._handleGameMessage(data);
        break;

      case 'failed':
        this.log.warn?.(`[GS] Action failed: ${JSON.stringify(data)}`);
        this.emit('action_failed', data);
        break;

      default:
        this.log.debug?.(`[GS] Unhandled event: ${eventName}`);
        this.emit('unknown_event', eventName, args);
    }
  }

  // ── Handle "change" event (main game state update) ─
  _handleChange(data) {
    if (!data || typeof data !== 'object') return;

    // Poker Now sends partial updates via gC/change events.
    // "<D>" means "delete this key". Nested objects must be deep-merged.
    if (!this.frame) {
      this.frame = data;
    } else {
      this._deepMerge(this.frame, data);
    }

    this._parseFrame(this.frame);
    this.emit('state_updated', this.hand);
  }

  // ── Deep merge with "<D>" deletion support ─────
  _deepMerge(target, source) {
    for (const key of Object.keys(source)) {
      const val = source[key];
      if (val === '<D>') {
        delete target[key];
      } else if (val && typeof val === 'object' && !Array.isArray(val)
                 && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
        this._deepMerge(target[key], val);
      } else {
        target[key] = val;
      }
    }
  }

  // ── Handle "registered" event (initial state) ──
  _handleRegistered(data) {
    if (!data) return;

    // Extract our player ID
    if (data.currentPlayer) {
      this.playerId = data.currentPlayer.id || this.playerId;
      this.hand.myId = this.playerId;
      this.log.info?.(`[GS] My player ID: ${this.playerId}`);
    }

    // Extract initial game state
    if (data.gameState) {
      this.frame = data.gameState;
      this._parseFrame(this.frame);
    }

    this.emit('registered', data);
    this.emit('state_updated', this.hand);
  }

  // ── Parse a full game frame ────────────────────
  _parseFrame(f) {
    if (!f) return;

    const prevPhase = this.hand.phase;
    const prevTurn  = this.hand.isMyTurn;

    // Detect new hand by game number (gN) or hand ID (hI)
    // This is the most reliable way — gN increments each hand
    let newHandDetected = false;
    if (f.gN !== undefined && f.gN !== this.hand.handNumber && this.hand.handNumber > 0) {
      this.log.info?.(`[GS] New hand detected: gN ${this.hand.handNumber} → ${f.gN}`);
      newHandDetected = true;
    }
    if (f.gN !== undefined) this.hand.handNumber = f.gN;

    if (newHandDetected) {
      // Reset hand state for new hand
      this.hand.actions = [];
      this.hand._actionKeys = new Set();
      this.hand.results = [];
      this.hand.communityCards = [];
      this.hand.myCards = [];
      this.hand.isMyTurn = false;
      this.hand.phase = 'preflop';
      this.emit('new_hand', this.hand);
    }

    // Basic game info
    this.hand.pot        = Number(f.pot) || 0;
    this.hand.bigBlind   = Number(f.bigBlind) || 0;
    this.hand.smallBlind = Number(f.smallBlind) || 0;
    this.hand.dealer     = f.dealerSeat ?? null;

    // Parse players (pass full frame for tB/pGS lookup)
    if (f.players) {
      this._parsePlayers(f.players, f.seats || [], f);
    }

    // Parse cards from pC (public cards / hole cards)
    if (f.pC) {
      this._parseCards(f.pC);
    }

    // Parse community cards from oTC (On The Table Cards)
    // Format: oTC: { "1": ["Qs", "3d", "Jh", ...] }
    if (f.oTC) {
      const board = [];
      for (const key of Object.keys(f.oTC)) {
        const cards = f.oTC[key];
        if (Array.isArray(cards)) {
          for (const c of cards) {
            if (typeof c === 'string') board.push(c);
          }
        }
      }
      if (board.length > 0) {
        this.hand.communityCards = board;
      }
    }

    // Re-determine phase after community cards update
    this._updatePhase(f);

    // Parse events data for action history
    if (f.eventsData && Array.isArray(f.eventsData)) {
      this._parseEventsData(f.eventsData);
    }

    // Detect if it's our turn
    this._detectMyTurn(f);

    // Detect phase transitions (still useful for flop/turn/river/showdown)
    if (this.hand.phase !== prevPhase && !newHandDetected) {
      this.log.info?.(`[GS] Phase: ${prevPhase} → ${this.hand.phase}`);
      if (this.hand.phase === 'preflop' && prevPhase !== 'preflop') {
        // Fallback new hand detection via phase
        this.hand.actions = [];
        this.hand._actionKeys = new Set();
        this.hand.results = [];
        this.emit('new_hand', this.hand);
      }
      if (this.hand.phase === 'flop') this.emit('board_updated', this.hand.communityCards);
      if (this.hand.phase === 'turn') this.emit('board_updated', this.hand.communityCards);
      if (this.hand.phase === 'river') this.emit('board_updated', this.hand.communityCards);
      if (this.hand.phase === 'showdown') this.emit('showdown', this.hand);
    }

    // Detect turn change
    if (this.hand.isMyTurn && !prevTurn) {
      this.emit('my_turn', {
        callAmount:   this.hand.callAmount,
        minRaise:     this.hand.minRaise,
        maxRaise:     this.hand.maxRaise,
        pot:          this.hand.pot,
        phase:        this.hand.phase,
      });
      this.log.info?.(`[GS] ★ MY TURN! call=${this.hand.callAmount}, pot=${this.hand.pot}`);
    }
  }

  // ── Determine game phase from frame ────────────
  _updatePhase(f) {
    // gT = game timeline/state array
    // Community cards count determines phase
    const communityCount = this.hand.communityCards.length;
    const status = f.status || '';

    if (status === 'waiting' || status === 'starting') {
      this.hand.phase = 'waiting';
    } else if (communityCount === 0) {
      this.hand.phase = 'preflop';
    } else if (communityCount === 3) {
      this.hand.phase = 'flop';
    } else if (communityCount === 4) {
      this.hand.phase = 'turn';
    } else if (communityCount >= 5) {
      this.hand.phase = 'river';
    }

    // Check for showdown via gT (game timeline)
    // gT[1]: 0=preflop, 1=flop, 2=turn, 3=river, 5=showdown
    if (f.gT && Array.isArray(f.gT)) {
      const phaseCode = f.gT[1];
      if (phaseCode === 5) {
        this.hand.phase = 'showdown';
      }
      // Also use gT to confirm phase when community cards might not be parsed yet
      if (phaseCode === 0 && communityCount === 0) this.hand.phase = 'preflop';
      if (phaseCode === 1 && communityCount >= 3) this.hand.phase = 'flop';
      if (phaseCode === 2 && communityCount >= 4) this.hand.phase = 'turn';
      if (phaseCode === 3 && communityCount >= 5) this.hand.phase = 'river';
    }
  }

  // ── Parse players from frame ───────────────────
  _parsePlayers(playersObj, seats, frame = {}) {
    if (!playersObj || typeof playersObj !== 'object') return;

    const tableBets = frame.tB || {};       // tB: {playerId: betAmount}
    const gameStatuses = frame.pGS || {};   // pGS: {playerId: "inGame"|"fold"|...}

    // Build seat mapping: seats is [[seatNum, playerId], ...]
    const seatMap = {};
    if (Array.isArray(seats)) {
      for (const entry of seats) {
        if (Array.isArray(entry) && entry.length >= 2) {
          seatMap[entry[1]] = entry[0]; // playerId → seatNum
        }
      }
    }

    this.hand.players = [];

    for (const [pid, p] of Object.entries(playersObj)) {
      const gs = gameStatuses[pid] || p.gameStatus || '';
      const bet = tableBets[pid] ?? Number(p.currentBet) ?? 0;
      const player = {
        id:     pid,
        seat:   seatMap[pid] ?? null,
        name:   p.name || pid,
        stack:  Number(p.stack) || 0,
        bet:    Number(bet) || 0,
        status: p.status || '',
        gameStatus: gs,
        folded: gs === 'fold',
        cards:  [],
        isMe:   pid === this.playerId || (this.botName && p.name === this.botName),
      };

      // If this is me, update my info (match by ID or by name)
      if (pid === this.playerId || (this.botName && p.name === this.botName)) {
        if (pid !== this.playerId) {
          this.log.info?.(`[GS] Matched by name "${this.botName}", updating playerId: ${this.playerId} → ${pid}`);
          this.playerId = pid;
        }
        this.hand.myName  = p.name || '';
        this.hand.mySeat  = player.seat;
        this.hand.myStack = player.stack;
        this.hand.myBetThisRound = player.bet;
        this.hand.myId    = pid;
      }

      this.hand.players.push(player);
    }
  }

  // ── Parse cards from pC ────────────────────────
  // pC structure: { playerId: [{value: "Ah"}, {value: "Kd"}], ... }
  // Community cards may be under a special key or separate field
  _parseCards(pC) {
    if (!pC || typeof pC !== 'object') return;

    // My hole cards
    // pC[playerId] can be: [{value:"Ah"}] or {cards: [{value:"Ah"}]}
    if (this.playerId && pC[this.playerId]) {
      let myCardData = pC[this.playerId];
      // Unwrap {cards: [...]} format
      if (!Array.isArray(myCardData) && myCardData.cards) {
        myCardData = myCardData.cards;
      }
      if (Array.isArray(myCardData)) {
        const prevCards = this.hand.myCards.join(',');
        this.hand.myCards = myCardData
          .map(c => (typeof c === 'object' && c.value) ? c.value : c)
          .filter(c => c && typeof c === 'string');

        if (this.hand.myCards.length > 0) {
          // Also update player record
          const me = this.hand.players.find(p => p.id === this.playerId);
          if (me) me.cards = this.hand.myCards;

          // Emit cards_dealt when we first receive hole cards
          if (prevCards !== this.hand.myCards.join(',')) {
            this.emit('cards_dealt', this.hand.myCards);
          }
        }
      }
    }

    // Community cards — look for non-player keys or board key
    // In Poker Now, community cards may be stored separately or
    // under keys like "board" or numeric indices
    const communityCards = [];
    for (const [key, cards] of Object.entries(pC)) {
      // Skip player IDs (they have alphanumeric IDs)
      // Community cards might be under numeric keys 0,1,2,3,4
      if (/^\d+$/.test(key) && Array.isArray(cards)) {
        for (const c of cards) {
          const val = (typeof c === 'object' && c.value) ? c.value : c;
          if (val && typeof val === 'string') communityCards.push(val);
        }
      }
    }

    // Alternative: look for a "board" or "community" key
    if (pC.board) {
      const board = Array.isArray(pC.board) ? pC.board : [pC.board];
      for (const c of board) {
        const val = (typeof c === 'object' && c.value) ? c.value : c;
        if (val) communityCards.push(val);
      }
    }

    if (communityCards.length > 0) {
      this.hand.communityCards = communityCards;
    }

    // Also check other player cards (visible at showdown)
    for (const player of this.hand.players) {
      if (player.id !== this.playerId && pC[player.id]) {
        let cardData = pC[player.id];
        if (!Array.isArray(cardData) && cardData.cards) cardData = cardData.cards;
        if (Array.isArray(cardData)) {
          player.cards = cardData
            .map(c => (typeof c === 'object' && c.value) ? c.value : c)
            .filter(c => c && typeof c === 'string');
        }
      }
    }
  }

  // ── Parse events data (action log) ─────────────
  // ACCUMULATES actions across the entire hand (doesn't reset each frame).
  // Uses _actionKeys Set to deduplicate.
  _parseEventsData(events) {
    for (const ev of events) {
      let parsed = null;
      if (typeof ev === 'string') {
        parsed = this._parseEventString(ev);
      } else if (typeof ev === 'object') {
        if (ev.action || ev.type) {
          parsed = {
            actor:  ev.player || ev.name || ev.id || 'unknown',
            action: (ev.action || ev.type || '').toLowerCase(),
            amount: Number(ev.amount || ev.value || 0),
            phase:  this.hand.phase,
          };
        }
      }
      if (parsed) {
        // Dedup key: actor + action + amount + phase
        const key = `${parsed.actor}|${parsed.action}|${parsed.amount}|${parsed.phase}`;
        if (!this.hand._actionKeys.has(key)) {
          this.hand._actionKeys.add(key);
          this.hand.actions.push(parsed);
        }
      }
    }
  }

  _parseEventString(str) {
    // Try to parse strings like "PlayerName folds", "PlayerName calls 20", etc.
    const foldMatch = str.match(/(.+?)\s+folds?/i);
    if (foldMatch) return { actor: foldMatch[1].trim(), action: 'fold', amount: 0, phase: this.hand.phase };

    const callMatch = str.match(/(.+?)\s+calls?\s+(\d+)/i);
    if (callMatch) return { actor: callMatch[1].trim(), action: 'call', amount: Number(callMatch[2]), phase: this.hand.phase };

    const raiseMatch = str.match(/(.+?)\s+raises?\s+(?:to\s+)?(\d+)/i);
    if (raiseMatch) return { actor: raiseMatch[1].trim(), action: 'raise', amount: Number(raiseMatch[2]), phase: this.hand.phase };

    const checkMatch = str.match(/(.+?)\s+checks?/i);
    if (checkMatch) return { actor: checkMatch[1].trim(), action: 'check', amount: 0, phase: this.hand.phase };

    const betMatch = str.match(/(.+?)\s+bets?\s+(\d+)/i);
    if (betMatch) return { actor: betMatch[1].trim(), action: 'bet', amount: Number(betMatch[2]), phase: this.hand.phase };

    const allinMatch = str.match(/(.+?)\s+(?:goes?\s+)?all[- ]?in\s*(?:with\s+)?(\d+)?/i);
    if (allinMatch) return { actor: allinMatch[1].trim(), action: 'allin', amount: Number(allinMatch[2]) || 0, phase: this.hand.phase };

    // Parse win results: "PlayerX wins 400", "PlayerX collected 400 from pot"
    const winMatch = str.match(/(.+?)\s+(?:wins?|collected|gains?)\s+(\d+)/i);
    if (winMatch) {
      const result = { winner: winMatch[1].trim(), amount: Number(winMatch[2]) };
      this.hand.results.push(result);
      return { actor: winMatch[1].trim(), action: 'wins', amount: Number(winMatch[2]), phase: 'showdown' };
    }

    return null;
  }

  // ── Detect if it's our turn ────────────────────
  _detectMyTurn(f) {
    if (!this.playerId) {
      this.hand.isMyTurn = false;
      return;
    }

    const me = this.hand.players.find(p => p.id === this.playerId);
    if (!me) {
      this.hand.isMyTurn = false;
      return;
    }

    // Primary: pITT (Player In The Turn) — the canonical turn indicator
    // pITT in the merged frame: playerId string = that player's turn, null = nobody's turn
    const pITT = f.pITT;
    this.log.info?.(`[GS] pITT=${pITT}, myId=${this.playerId}, match=${pITT === this.playerId}`);

    if (pITT && pITT === this.playerId) {
      this.hand.isMyTurn = true;
      this._calculateActionParams(f, me);
      return;
    }

    // If pITT is explicitly set (even to null or another player), trust it
    if (pITT !== undefined) {
      this.hand.isMyTurn = false;
      return;
    }

    // Fallback: actionStartedAt being set means it's that player's turn
    const meRaw = f.players && f.players[this.playerId];
    if (meRaw && meRaw.actionStartedAt && meRaw.gameStatus === 'inGame') {
      this.hand.isMyTurn = true;
      this._calculateActionParams(f, me);
    } else {
      this.hand.isMyTurn = false;
    }
  }

  // ── Calculate call/raise amounts ───────────────
  _calculateActionParams(f, me) {
    // Use frame-level fields first (tB = table bets, cHB = current highest bet, mR = min raise)
    // NOTE: tB values can be numbers (bet amounts) or strings ("check", "<D>") — only use numeric values
    const tableBets = f.tB || {};
    const myBetRaw = tableBets[this.playerId];
    const myBet = (typeof myBetRaw === 'number') ? myBetRaw : (Number(me.bet) || 0);
    const highestBet = Number(f.cHB) || 0;

    // Find highest bet from table bets or player list
    let maxBet = highestBet;
    if (!maxBet) {
      // Only use numeric tB values
      for (const [, val] of Object.entries(tableBets)) {
        if (typeof val === 'number' && val > maxBet) maxBet = val;
      }
    }
    if (!maxBet) {
      for (const p of this.hand.players) {
        if ((Number(p.bet) || 0) > maxBet) maxBet = Number(p.bet) || 0;
      }
    }

    this.hand.callAmount = Math.max(0, maxBet - myBet);
    this.hand.currentBet = maxBet;
    this.hand.myBetThisRound = myBet;

    // Use frame mR (min raise) if available, otherwise calculate
    const bb = this.hand.bigBlind || 20;
    this.hand.minRaise = Number(f.mR) || Math.max(maxBet + bb, maxBet * 2);
    this.hand.maxRaise = (Number(me.stack) || 0) + myBet; // total bet = stack + current bet

    // Clamp
    if (this.hand.minRaise > this.hand.maxRaise) {
      this.hand.minRaise = this.hand.maxRaise;
    }
  }

  // ── Handle event messages (nEM — real-time action feed) ──
  // nEM events carry the actual hand actions like "Enyan raises to 60"
  // These are the PRIMARY source of per-action history during a hand.
  _handleEventMessage(data) {
    if (!data) return;
    this.log.info?.(`[GS] nEM: ${JSON.stringify(data).substring(0, 200)}`);

    // nEM can be a string or object with a msg/message field
    let text = null;
    if (typeof data === 'string') {
      text = data;
    } else if (typeof data === 'object') {
      text = data.msg || data.message || data.text || data.value || null;
      // Some nEM have a .log array of strings
      if (!text && Array.isArray(data.log)) {
        for (const entry of data.log) {
          if (typeof entry === 'string') {
            this._accumulateAction(entry);
          }
        }
      }
    }

    if (text && typeof text === 'string') {
      this._accumulateAction(text);
    }

    this.emit('event_message', data);
  }

  // ── Parse a single action string and accumulate if valid ──
  _accumulateAction(text) {
    const parsed = this._parseEventString(text);
    if (parsed) {
      const key = `${parsed.actor}|${parsed.action}|${parsed.amount}|${parsed.phase}`;
      if (!this.hand._actionKeys.has(key)) {
        this.hand._actionKeys.add(key);
        this.hand.actions.push(parsed);
        this.log.info?.(`[GS] Action: ${parsed.actor} ${parsed.action}${parsed.amount ? ' $' + parsed.amount : ''}`);
      }
    }
  }

  // ── Handle GAME:TO_CLIENT messages ─────────────
  _handleGameMessage(data) {
    if (!data) return;
    this.log.debug?.(`[GS] Game message: ${JSON.stringify(data).substring(0, 200)}`);
    this.emit('game_message', data);
  }

  // ── Build context for Claude ───────────────────
  getClaudeContext() {
    const h = this.hand;

    // Position calculation
    const activePlayers = h.players.filter(p => !p.folded && p.status === 'inGame');
    let position = 'unknown';
    if (h.mySeat !== null && h.dealer !== null && activePlayers.length > 0) {
      // Simple position estimation
      const totalActive = activePlayers.length;
      if (h.mySeat === h.dealer) position = 'BTN';
      // More sophisticated position calc would need seat ordering
    }

    return {
      phase:          h.phase,
      myCards:        h.myCards,
      communityCards: h.communityCards,
      pot:            h.pot,
      myStack:        h.myStack,
      callAmount:     h.callAmount,
      minRaise:       h.minRaise,
      maxRaise:       h.maxRaise,
      currentBet:     h.currentBet,
      players:        h.players.map(p => {
        const out = {
          name:       p.name,
          stack:      p.stack,
          bet:        p.bet,
          folded:     p.folded,
          status:     p.gameStatus,
          isMe:       p.isMe,
        };
        // Include revealed cards at showdown
        if (p.cards && p.cards.length > 0) out.cards = p.cards;
        return out;
      }),
      actions:        h.actions,  // full hand history (accumulated, not truncated)
      results:        h.results,
      smallBlind:     h.smallBlind,
      bigBlind:       h.bigBlind,
      dealer:         h.dealer,
      mySeat:         h.mySeat,
      position,
    };
  }
}

module.exports = { GameState };
