/**
 * poker-engine.js — Pure Texas Hold'em Game Engine
 *
 * Zero I/O, zero dependencies. Just game logic.
 * Feed it actions, it produces state. Plug into any transport (HTTP, WS, file-based).
 *
 * Usage:
 *   const { PokerEngine } = require('./poker-engine');
 *   const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20 });
 *   engine.addPlayer('Alice', 1000);
 *   engine.addPlayer('Bob', 1000);
 *   engine.startHand();
 *   engine.act('Alice', 'call');
 *   engine.act('Bob', 'check');
 *   // ... engine emits events, getState() returns full state
 */

const EventEmitter = require('events');

// ══════════════════════════════════════════════════
// CARD / DECK
// ══════════════════════════════════════════════════

const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const SUITS = ['h','d','c','s'];
const RANK_VALUE = {};
RANKS.forEach((r, i) => RANK_VALUE[r] = i + 2); // 2=2 ... A=14

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

function shuffleDeck(deck) {
  // Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ══════════════════════════════════════════════════
// HAND EVALUATOR
// ══════════════════════════════════════════════════
// Returns { rank: 0-8, values: [...], name: string }
// rank: 0=high card, 1=pair, 2=two pair, 3=trips, 4=straight,
//       5=flush, 6=full house, 7=quads, 8=straight flush

function parseCard(card) {
  return { rank: RANK_VALUE[card[0]], suit: card[1] };
}

function evaluateHand(cards) {
  // cards: array of 5-7 card codes like "Ah", "Kd"
  if (cards.length < 5) return { rank: -1, values: [], name: 'incomplete' };

  const parsed = cards.map(parseCard);

  // Generate all 5-card combos if >5 cards
  const combos = cards.length === 5 ? [parsed] : combinations(parsed, 5);

  let best = null;
  for (const combo of combos) {
    const result = evaluate5(combo);
    if (!best || compareHands(result, best) > 0) best = result;
  }
  return best;
}

function combinations(arr, k) {
  const result = [];
  function dfs(start, path) {
    if (path.length === k) { result.push([...path]); return; }
    for (let i = start; i < arr.length; i++) {
      path.push(arr[i]);
      dfs(i + 1, path);
      path.pop();
    }
  }
  dfs(0, []);
  return result;
}

function evaluate5(cards) {
  const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);

  const isFlush = suits.every(s => s === suits[0]);

  // Check straight (including wheel: A-2-3-4-5)
  let isStraight = false;
  let straightHigh = 0;
  const uniqueRanks = [...new Set(ranks)].sort((a, b) => b - a);
  if (uniqueRanks.length >= 5) {
    // Normal straight
    for (let i = 0; i <= uniqueRanks.length - 5; i++) {
      if (uniqueRanks[i] - uniqueRanks[i + 4] === 4) {
        isStraight = true;
        straightHigh = uniqueRanks[i];
        break;
      }
    }
    // Wheel (A-2-3-4-5)
    if (!isStraight && uniqueRanks.includes(14) && uniqueRanks.includes(2) &&
        uniqueRanks.includes(3) && uniqueRanks.includes(4) && uniqueRanks.includes(5)) {
      isStraight = true;
      straightHigh = 5; // 5-high straight
    }
  }

  // Count rank frequencies
  const freq = {};
  for (const r of ranks) freq[r] = (freq[r] || 0) + 1;
  const groups = Object.entries(freq)
    .map(([r, c]) => ({ rank: parseInt(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  const counts = groups.map(g => g.count);

  // Straight flush
  if (isFlush && isStraight) {
    return { rank: 8, values: [straightHigh], name: straightHigh === 14 ? 'Royal Flush' : 'Straight Flush' };
  }
  // Four of a kind
  if (counts[0] === 4) {
    return { rank: 7, values: [groups[0].rank, groups[1].rank], name: 'Four of a Kind' };
  }
  // Full house
  if (counts[0] === 3 && counts[1] >= 2) {
    return { rank: 6, values: [groups[0].rank, groups[1].rank], name: 'Full House' };
  }
  // Flush
  if (isFlush) {
    return { rank: 5, values: ranks.slice(0, 5), name: 'Flush' };
  }
  // Straight
  if (isStraight) {
    return { rank: 4, values: [straightHigh], name: 'Straight' };
  }
  // Three of a kind
  if (counts[0] === 3) {
    const kickers = groups.filter(g => g.count === 1).map(g => g.rank).slice(0, 2);
    return { rank: 3, values: [groups[0].rank, ...kickers], name: 'Three of a Kind' };
  }
  // Two pair
  if (counts[0] === 2 && counts[1] === 2) {
    const pairs = groups.filter(g => g.count === 2).map(g => g.rank).sort((a, b) => b - a);
    const kicker = groups.find(g => g.count === 1)?.rank || 0;
    return { rank: 2, values: [...pairs, kicker], name: 'Two Pair' };
  }
  // One pair
  if (counts[0] === 2) {
    const kickers = groups.filter(g => g.count === 1).map(g => g.rank).slice(0, 3);
    return { rank: 1, values: [groups[0].rank, ...kickers], name: 'Pair' };
  }
  // High card
  return { rank: 0, values: ranks.slice(0, 5), name: 'High Card' };
}

function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.min(a.values.length, b.values.length); i++) {
    if (a.values[i] !== b.values[i]) return a.values[i] - b.values[i];
  }
  return 0;
}

// ══════════════════════════════════════════════════
// PLAYER
// ══════════════════════════════════════════════════

class Player {
  constructor(name, stack, seat) {
    this.name = name;
    this.stack = stack;
    this.seat = seat;
    this.cards = [];          // hole cards
    this.bet = 0;             // current round bet
    this.totalBet = 0;        // total bet this hand
    this.folded = false;
    this.allIn = false;
    this.sittingOut = false;
    this.connected = true;
  }

  reset() {
    this.cards = [];
    this.bet = 0;
    this.totalBet = 0;
    this.folded = false;
    this.allIn = false;
  }
}

// ══════════════════════════════════════════════════
// POKER ENGINE
// ══════════════════════════════════════════════════

const PHASES = ['preflop', 'flop', 'turn', 'river', 'showdown'];

class PokerEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.smallBlind = opts.smallBlind || 10;
    this.bigBlind   = opts.bigBlind   || 20;
    this.maxPlayers = opts.maxPlayers  || 9;
    this.autoStart  = opts.autoStart ?? true;  // auto-start next hand

    this.players = new Map();     // name → Player
    this.seatOrder = [];          // seat indices in order
    this.dealerSeat = -1;         // current dealer seat index

    // Hand state
    this.phase = 'waiting';       // waiting | preflop | flop | turn | river | showdown
    this.deck = [];
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];           // [{ amount, eligible: [name, ...] }]
    this.actions = [];            // [{ actor, action, amount, phase }]
    this.handNumber = 0;
    this._paused = false;

    // Betting round state
    this._currentPlayerIdx = -1;  // index into _activePlayers
    this._lastRaiserIdx = -1;     // who last raised (round ends when back to them)
    this._currentBet = 0;         // current bet to match
    this._minRaise = 0;           // minimum raise increment
    this._roundActed = new Set(); // who has acted this round
  }

  // ── Player management ─────────────────────────

  addPlayer(name, stack, seat) {
    if (this.players.has(name)) return { ok: false, error: 'Name taken' };
    if (this.players.size >= this.maxPlayers) return { ok: false, error: 'Table full' };

    // Auto-assign seat if not provided
    if (seat === undefined || seat === null) {
      const taken = new Set([...this.players.values()].map(p => p.seat));
      for (let s = 0; s < this.maxPlayers; s++) {
        if (!taken.has(s)) { seat = s; break; }
      }
      if (seat === undefined) return { ok: false, error: 'No seats available' };
    }

    const player = new Player(name, stack, seat);
    this.players.set(name, player);
    this._updateSeatOrder();

    this.emit('player_joined', { name, stack, seat });

    // Auto-start if enough players and waiting
    if (this.phase === 'waiting' && this.autoStart && this._readyPlayers().length >= 2) {
      setTimeout(() => this.startHand(), 500);
    }

    return { ok: true, seat };
  }

  removePlayer(name) {
    const player = this.players.get(name);
    if (!player) return { ok: false, error: 'Not found' };

    // If mid-hand, fold them first
    if (this.phase !== 'waiting' && !player.folded) {
      player.folded = true;
    }

    this.players.delete(name);
    this._updateSeatOrder();
    this.emit('player_left', { name });

    // Check if hand should end
    if (this.phase !== 'waiting') {
      this._checkHandEnd();
    }

    return { ok: true };
  }

  rebuy(name, amount) {
    const player = this.players.get(name);
    if (!player) return { ok: false, error: 'Player not found' };
    if (player.stack > 0 && this.phase !== 'waiting') {
      return { ok: false, error: 'Can only rebuy when busted or between hands' };
    }
    if (!amount || amount <= 0) return { ok: false, error: 'Invalid amount' };

    player.stack += amount;
    player.sittingOut = false;
    this.emit('player_rebuy', { name, amount, newStack: player.stack });

    // Auto-start if enough players and waiting
    if (this.phase === 'waiting' && this.autoStart && this._readyPlayers().length >= 2) {
      setTimeout(() => this.startHand(), 500);
    }

    return { ok: true, stack: player.stack };
  }

  // ── Sit out / sit back ─────────────────────────

  sitOut(name) {
    const player = this.players.get(name);
    if (!player) return { ok: false, error: 'Player not found' };
    if (player.sittingOut) return { ok: false, error: 'Already sitting out' };
    player.sittingOut = true;
    // If mid-hand, fold them
    if (this.phase !== 'waiting' && !player.folded) {
      player.folded = true;
      this._checkHandEnd();
    }
    this.emit('player_sit_out', { name });
    return { ok: true };
  }

  sitBack(name) {
    const player = this.players.get(name);
    if (!player) return { ok: false, error: 'Player not found' };
    if (!player.sittingOut) return { ok: false, error: 'Not sitting out' };
    if (player.stack <= 0) return { ok: false, error: 'Need to rebuy first (stack is 0)' };
    player.sittingOut = false;
    this.emit('player_sit_back', { name });
    // Auto-start if enough players
    if (this.phase === 'waiting' && this.autoStart && this._readyPlayers().length >= 2) {
      setTimeout(() => this.startHand(), 500);
    }
    return { ok: true };
  }

  // ── Kick player ────────────────────────────────

  kick(name) {
    const player = this.players.get(name);
    if (!player) return { ok: false, error: 'Player not found' };
    // Fold if mid-hand
    if (this.phase !== 'waiting' && !player.folded) {
      player.folded = true;
    }
    this.players.delete(name);
    this._updateSeatOrder();
    this.emit('player_kicked', { name });
    if (this.phase !== 'waiting') this._checkHandEnd();
    return { ok: true };
  }

  // ── Pause / resume ─────────────────────────────

  pause() {
    if (this._paused) return { ok: false, error: 'Already paused' };
    this._paused = true;
    this.emit('game_paused', {});
    return { ok: true };
  }

  resume() {
    if (!this._paused) return { ok: false, error: 'Not paused' };
    this._paused = false;
    this.emit('game_resumed', {});
    // If waiting and enough players, auto-start
    if (this.phase === 'waiting' && this.autoStart && this._readyPlayers().length >= 2) {
      setTimeout(() => this.startHand(), 1000);
    }
    return { ok: true };
  }

  // ── Update settings (between hands only) ───────

  updateSettings(opts) {
    if (this.phase !== 'waiting') return { ok: false, error: 'Can only change settings between hands' };
    const newSB = (opts.smallBlind !== undefined && opts.smallBlind > 0) ? opts.smallBlind : this.smallBlind;
    const newBB = (opts.bigBlind !== undefined && opts.bigBlind > 0) ? opts.bigBlind : this.bigBlind;
    if (newBB <= newSB) return { ok: false, error: `Big blind ($${newBB}) must be greater than small blind ($${newSB})` };
    this.smallBlind = newSB;
    this.bigBlind = newBB;
    if (opts.autoStart !== undefined) this.autoStart = !!opts.autoStart;
    this.emit('settings_changed', { smallBlind: this.smallBlind, bigBlind: this.bigBlind, autoStart: this.autoStart });
    return { ok: true, smallBlind: this.smallBlind, bigBlind: this.bigBlind, autoStart: this.autoStart };
  }

  _updateSeatOrder() {
    this.seatOrder = [...this.players.values()]
      .sort((a, b) => a.seat - b.seat)
      .map(p => p.name);
  }

  _readyPlayers() {
    return [...this.players.values()].filter(p => !p.sittingOut && p.stack > 0);
  }

  _activePlayers() {
    return this.seatOrder.filter(name => {
      const p = this.players.get(name);
      return p && !p.folded && !p.sittingOut;
    });
  }

  _actionPlayers() {
    // Players who can still act (not folded, not all-in)
    return this.seatOrder.filter(name => {
      const p = this.players.get(name);
      return p && !p.folded && !p.allIn && !p.sittingOut;
    });
  }

  // ── Hand lifecycle ────────────────────────────

  startHand() {
    if (this._paused) return false;
    const ready = this._readyPlayers();
    if (ready.length < 2) {
      this.emit('error', { message: 'Need at least 2 players' });
      return false;
    }

    this.handNumber++;

    // Unsit players who were waiting to join (mid-hand joins)
    for (const p of this.players.values()) {
      if (p.sittingOut && p.stack > 0) p.sittingOut = false;
    }

    // Reset players — only ready players participate; bust/sitting-out players are folded
    const readySet = new Set(ready.map(p => p.name));
    for (const p of this.players.values()) {
      p.reset();
      if (!readySet.has(p.name)) {
        p.folded = true;  // exclude from _activePlayers / _actionPlayers
      }
    }

    // Advance dealer
    this._advanceDealer(ready);

    // Shuffle deck
    this.deck = shuffleDeck(makeDeck());
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.actions = [];
    this.phase = 'preflop';

    // Post blinds
    this._postBlinds(ready);

    // Deal hole cards
    for (const p of ready) {
      p.cards = [this.deck.pop(), this.deck.pop()];
    }

    this.emit('hand_start', {
      handNumber: this.handNumber,
      dealer: this.seatOrder[this._dealerIdx()],
      positions: this.getPositions(),
      players: ready.map(p => ({ name: p.name, stack: p.stack, seat: p.seat })),
    });

    // Emit cards_dealt per player (private)
    for (const p of ready) {
      this.emit('cards_dealt', { player: p.name, cards: [...p.cards] });
    }

    // Start preflop betting
    this._startBettingRound();

    return true;
  }

  _advanceDealer(ready) {
    const readyNames = ready.map(p => p.name);
    if (this.dealerSeat < 0) {
      // First hand — random dealer
      this.dealerSeat = ready[Math.floor(Math.random() * ready.length)].seat;
    } else {
      // Find current dealer's index in seatOrder. If player was removed,
      // find the closest seat index to maintain clockwise rotation.
      let currentIdx = this.seatOrder.findIndex(name => {
        const p = this.players.get(name);
        return p && p.seat === this.dealerSeat;
      });
      if (currentIdx < 0) {
        // Dealer was removed — find first ready player as fallback
        currentIdx = 0;
      }
      for (let i = 1; i <= this.seatOrder.length; i++) {
        const nextName = this.seatOrder[(currentIdx + i) % this.seatOrder.length];
        if (readyNames.includes(nextName)) {
          this.dealerSeat = this.players.get(nextName).seat;
          break;
        }
      }
    }
  }

  _dealerIdx() {
    if (this.seatOrder.length === 0) return 0; // guard: prevent modulo-by-zero
    const idx = this.seatOrder.findIndex(name => this.players.get(name)?.seat === this.dealerSeat);
    return idx >= 0 ? idx : 0; // fallback to 0 if dealer not found
  }

  _postBlinds(ready) {
    const readyNames = ready.map(p => p.name);
    const dealerIdx = this._dealerIdx();
    const n = readyNames.length;

    let sbIdx, bbIdx;
    if (n === 2) {
      // Heads-up: dealer is SB, other is BB
      sbIdx = this.seatOrder.indexOf(readyNames.find(name =>
        this.players.get(name).seat === this.dealerSeat));
      bbIdx = this.seatOrder.indexOf(readyNames.find(name =>
        this.players.get(name).seat !== this.dealerSeat));
    } else {
      // SB = first ready player after dealer, BB = next
      let found = 0;
      for (let i = 1; i <= this.seatOrder.length; i++) {
        const name = this.seatOrder[(dealerIdx + i) % this.seatOrder.length];
        if (readyNames.includes(name)) {
          found++;
          if (found === 1) sbIdx = this.seatOrder.indexOf(name);
          if (found === 2) { bbIdx = this.seatOrder.indexOf(name); break; }
        }
      }
    }

    const sbName = this.seatOrder[sbIdx];
    const bbName = this.seatOrder[bbIdx];

    this._forceBet(sbName, this.smallBlind, 'small_blind');
    this._forceBet(bbName, this.bigBlind, 'big_blind');

    this._currentBet = this.bigBlind;
    this._minRaise = this.bigBlind;
  }

  _forceBet(name, amount, type) {
    const p = this.players.get(name);
    const actual = Math.min(amount, p.stack);
    p.stack -= actual;
    p.bet += actual;
    p.totalBet += actual;
    this.pot += actual;
    if (p.stack === 0) p.allIn = true;

    this.actions.push({ actor: name, action: type, amount: actual, phase: this.phase });
    this.emit('blind_posted', { player: name, type, amount: actual });
  }

  // ── Betting round ─────────────────────────────

  _startBettingRound() {
    this._roundActed = new Set();

    const actionPlayers = this._actionPlayers();
    if (actionPlayers.length <= 1) {
      // Everyone else is all-in or folded — skip to deal remaining
      this._advancePhase();
      return;
    }

    // Determine who acts first
    if (this.phase === 'preflop') {
      // UTG = first ready player after BB
      const ready = this._readyPlayers().map(p => p.name);
      const dealerIdx = this._dealerIdx();
      const n = ready.length;
      // Find BB index
      let bbIdx;
      if (n === 2) {
        bbIdx = this.seatOrder.indexOf(ready.find(name =>
          this.players.get(name).seat !== this.dealerSeat));
      } else {
        let found = 0;
        for (let i = 1; i <= this.seatOrder.length; i++) {
          const name = this.seatOrder[(dealerIdx + i) % this.seatOrder.length];
          if (ready.includes(name)) {
            found++;
            if (found === 2) { bbIdx = this.seatOrder.indexOf(name); break; }
          }
        }
      }
      // UTG = next action player after BB
      this._currentPlayerIdx = this._nextActionPlayerAfter(bbIdx);
    } else {
      // Postflop: first action player after dealer
      this._currentPlayerIdx = this._nextActionPlayerAfter(this._dealerIdx());
    }

    this._lastRaiserIdx = -1;
    this._promptCurrentPlayer();
  }

  _nextActionPlayerAfter(seatIdx) {
    const actionPlayers = this._actionPlayers();
    for (let i = 1; i <= this.seatOrder.length; i++) {
      const name = this.seatOrder[(seatIdx + i) % this.seatOrder.length];
      if (actionPlayers.includes(name)) {
        return this.seatOrder.indexOf(name);
      }
    }
    return -1;
  }

  _promptCurrentPlayer() {
    if (this._currentPlayerIdx < 0) {
      this._advancePhase();
      return;
    }

    const name = this.seatOrder[this._currentPlayerIdx];
    const player = this.players.get(name);
    if (!player || player.folded || player.allIn) {
      this._advanceToNextPlayer();
      return;
    }

    const callAmount = Math.max(0, Math.min(this._currentBet - player.bet, player.stack));
    const minRaise = Math.min(this._currentBet + this._minRaise, player.stack + player.bet);
    const maxRaise = player.stack + player.bet; // all-in

    this.emit('action_required', {
      player: name,
      callAmount,
      minRaise,
      maxRaise: Math.max(maxRaise, minRaise),
      pot: this.pot,
      phase: this.phase,
      currentBet: this._currentBet,
    });
  }

  // ── Act ───────────────────────────────────────

  act(playerName, action, amount) {
    const player = this.players.get(playerName);
    if (!player) return { ok: false, error: 'Unknown player' };
    if (this.seatOrder[this._currentPlayerIdx] !== playerName) {
      return { ok: false, error: 'Not your turn' };
    }
    if (player.folded || player.allIn) {
      return { ok: false, error: 'Cannot act' };
    }

    const callAmount = this._currentBet - player.bet;

    switch (action.toLowerCase()) {
      case 'fold':
        player.folded = true;
        this.actions.push({ actor: playerName, action: 'fold', phase: this.phase });
        this.emit('player_acted', { player: playerName, action: 'fold' });
        break;

      case 'check':
        if (callAmount > 0) return { ok: false, error: `Must call $${callAmount} or fold` };
        // Safety: treat as check even if bet tracking is slightly off
        if (player.bet > this._currentBet) this._currentBet = player.bet;
        this.actions.push({ actor: playerName, action: 'check', phase: this.phase });
        this.emit('player_acted', { player: playerName, action: 'check' });
        break;

      case 'call':
        if (callAmount <= 0) return { ok: false, error: 'Nothing to call — use check' };
        const callAmt = Math.min(callAmount, player.stack);
        player.stack -= callAmt;
        player.bet += callAmt;
        player.totalBet += callAmt;
        this.pot += callAmt;
        if (player.stack === 0) player.allIn = true;
        this.actions.push({ actor: playerName, action: 'call', amount: callAmt, phase: this.phase });
        this.emit('player_acted', { player: playerName, action: 'call', amount: callAmt });
        break;

      case 'raise':
      case 'bet': {
        const raiseTotal = parseInt(amount);
        if (!raiseTotal || raiseTotal <= 0) return { ok: false, error: 'Amount required' };

        const minTotal = this._currentBet + this._minRaise;
        const maxTotal = player.stack + player.bet;

        // Allow all-in even if below min raise
        if (raiseTotal < minTotal && raiseTotal < maxTotal) {
          return { ok: false, error: `Min raise: $${minTotal} (or all-in $${maxTotal})` };
        }

        const actualTotal = Math.min(raiseTotal, maxTotal);
        const addedAmount = actualTotal - player.bet;

        if (addedAmount > player.stack) {
          return { ok: false, error: `Not enough chips (have $${player.stack})` };
        }

        // Update min raise
        const raiseIncrement = actualTotal - this._currentBet;
        if (raiseIncrement > this._minRaise) {
          this._minRaise = raiseIncrement;
        }

        player.stack -= addedAmount;
        player.bet += addedAmount;
        player.totalBet += addedAmount;
        this.pot += addedAmount;
        this._currentBet = actualTotal;
        if (player.stack === 0) player.allIn = true;

        this._lastRaiserIdx = this._currentPlayerIdx;
        this._roundActed = new Set(); // raise resets who needs to act

        const actLabel = callAmount === 0 ? 'bet' : 'raise';
        this.actions.push({ actor: playerName, action: actLabel, amount: actualTotal, phase: this.phase });
        this.emit('player_acted', { player: playerName, action: actLabel, amount: actualTotal });
        break;
      }

      default:
        return { ok: false, error: `Unknown action: ${action}` };
    }

    this._roundActed.add(playerName);

    // Check if hand ended (everyone folded)
    const active = this._activePlayers();
    if (active.length <= 1) {
      this._awardPot();
      return { ok: true };
    }

    // Advance to next player
    this._advanceToNextPlayer();
    return { ok: true };
  }

  _advanceToNextPlayer() {
    const actionPlayers = this._actionPlayers();

    // If only 0-1 action players left, advance phase
    if (actionPlayers.length <= 1) {
      this._advancePhase();
      return;
    }

    // Safety: if all action players have acted and bets match, advance
    if (actionPlayers.every(n => this._roundActed.has(n) &&
        (this.players.get(n).bet === this._currentBet || this.players.get(n).allIn))) {
      this._advancePhase();
      return;
    }

    // Find next action player
    for (let i = 1; i <= this.seatOrder.length; i++) {
      const idx = (this._currentPlayerIdx + i) % this.seatOrder.length;
      const name = this.seatOrder[idx];
      const p = this.players.get(name);

      if (!p || p.folded || p.allIn || p.sittingOut) continue;

      // Round ends when we get back to the last raiser, or everyone has acted and bets are equal
      if (this._lastRaiserIdx >= 0 && idx === this._lastRaiserIdx && this._roundActed.has(name)) {
        this._advancePhase();
        return;
      }

      // If no raise happened, round ends when everyone has acted
      if (this._lastRaiserIdx < 0 && this._roundActed.has(name) && p.bet === this._currentBet) {
        this._advancePhase();
        return;
      }

      // This player needs to act
      this._currentPlayerIdx = idx;
      this._promptCurrentPlayer();
      return;
    }

    // Shouldn't reach here, but just in case
    this._advancePhase();
  }

  // ── Phase transitions ─────────────────────────

  _advancePhase() {
    // Reset bets and betting state for new round
    for (const p of this.players.values()) {
      p.bet = 0;
    }
    this._currentBet = 0;
    this._lastRaiserIdx = -1;
    this._roundActed = new Set();

    const phaseIdx = PHASES.indexOf(this.phase);

    switch (this.phase) {
      case 'preflop':
        this.phase = 'flop';
        this.deck.pop(); // burn
        this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
        this.emit('board_dealt', { phase: 'flop', cards: [...this.communityCards] });
        break;
      case 'flop':
        this.phase = 'turn';
        this.deck.pop(); // burn
        this.communityCards.push(this.deck.pop());
        this.emit('board_dealt', { phase: 'turn', cards: [...this.communityCards] });
        break;
      case 'turn':
        this.phase = 'river';
        this.deck.pop(); // burn
        this.communityCards.push(this.deck.pop());
        this.emit('board_dealt', { phase: 'river', cards: [...this.communityCards] });
        break;
      case 'river':
        this.phase = 'showdown';
        this._awardPot();
        return;
    }

    // Start new betting round (or skip if not enough action players)
    this._startBettingRound();
  }

  // ── Pot / Showdown ────────────────────────────

  _awardPot() {
    this.phase = 'showdown';
    const active = this._activePlayers();

    if (active.length === 1) {
      // Everyone else folded
      const winner = this.players.get(active[0]);
      winner.stack += this.pot;
      const results = [{ winner: active[0], amount: this.pot, hand: null }];
      this.emit('hand_end', {
        results,
        pot: this.pot,
        board: [...this.communityCards],
        players: this._getPlayersState(true),
      });
      this.pot = 0;
      this._scheduleNextHand();
      return;
    }

    // Evaluate hands
    const handResults = [];
    for (const name of active) {
      const p = this.players.get(name);
      const allCards = [...p.cards, ...this.communityCards];
      const evaluation = evaluateHand(allCards);
      handResults.push({ name, eval: evaluation, totalBet: p.totalBet });
    }

    // Build side pots
    const pots = this._buildSidePots();
    const results = [];

    for (const pot of pots) {
      const eligible = handResults.filter(h => pot.eligible.includes(h.name));
      eligible.sort((a, b) => compareHands(b.eval, a.eval));

      // Find all winners (ties)
      const best = eligible[0];
      const winners = eligible.filter(h => compareHands(h.eval, best.eval) === 0);
      const share = Math.floor(pot.amount / winners.length);
      const remainder = pot.amount - share * winners.length;

      winners.forEach((w, i) => {
        const winAmount = share + (i === 0 ? remainder : 0);
        this.players.get(w.name).stack += winAmount;
        results.push({
          winner: w.name,
          amount: winAmount,
          hand: w.eval.name,
          cards: [...this.players.get(w.name).cards],
        });
      });
    }

    this.emit('hand_end', {
      results,
      pot: this.pot,
      board: [...this.communityCards],
      players: this._getPlayersState(true),
    });

    this.pot = 0;
    this._scheduleNextHand();
  }

  _buildSidePots() {
    // Collect all contributions
    const contribs = [];
    for (const [name, p] of this.players) {
      if (p.totalBet > 0) {
        contribs.push({ name, amount: p.totalBet, folded: p.folded });
      }
    }

    if (contribs.length === 0) return [{ amount: this.pot, eligible: this._activePlayers() }];

    // Sort by contribution amount
    contribs.sort((a, b) => a.amount - b.amount);

    const pots = [];
    let prevLevel = 0;

    const levels = [...new Set(contribs.map(c => c.amount))].sort((a, b) => a - b);

    for (const level of levels) {
      const increment = level - prevLevel;
      if (increment <= 0) continue;

      const eligible = contribs
        .filter(c => c.amount >= level && !c.folded)
        .map(c => c.name);
      const contributors = contribs.filter(c => c.amount >= level).length;
      const potAmount = increment * contributors;

      if (potAmount > 0 && eligible.length > 0) {
        pots.push({ amount: potAmount, eligible });
      }

      prevLevel = level;
    }

    // Verify pot totals match
    const totalPots = pots.reduce((s, p) => s + p.amount, 0);
    if (totalPots < this.pot) {
      // Remaining goes to last pot
      if (pots.length > 0) {
        pots[pots.length - 1].amount += this.pot - totalPots;
      } else {
        pots.push({ amount: this.pot, eligible: this._activePlayers() });
      }
    }

    return pots;
  }

  _scheduleNextHand() {
    this.phase = 'waiting';

    // Remove busted players
    for (const [name, p] of this.players) {
      if (p.stack <= 0) {
        this.emit('player_busted', { name });
      }
    }

    if (this.autoStart && !this._paused) {
      setTimeout(() => {
        if (this._paused) return;
        if (this._readyPlayers().length >= 2) {
          this.startHand();
        } else {
          this.emit('waiting_for_players', {
            ready: this._readyPlayers().length,
            needed: 2,
          });
        }
      }, 3000); // 3s between hands
    }
  }

  _checkHandEnd() {
    const active = this._activePlayers();
    if (active.length <= 1 && this.phase !== 'waiting' && this.phase !== 'showdown') {
      this._awardPot();
    }
  }

  // ── Position calculation ──────────────────────
  // Returns { playerName: "BTN", ... } for all ready players
  // Standard positions (in action order): SB, BB, UTG, UTG+1, MP, HJ, CO, BTN
  // Heads-up: BTN/SB, BB
  getPositions() {
    const ready = this._readyPlayers().map(p => p.name);
    const n = ready.length;
    if (n === 0 || this.dealerSeat < 0) return {};

    const dealerIdx = this._dealerIdx();
    const positions = {};

    if (n === 2) {
      // Heads-up: dealer = BTN + SB, other = BB
      const dealerName = this.seatOrder[dealerIdx];
      positions[dealerName] = 'BTN';
      const other = ready.find(name => name !== dealerName);
      if (other) positions[other] = 'BB';
    } else if (n === 3) {
      // 3-handed: BTN, SB, BB
      const labels = ['BTN', 'SB', 'BB'];
      for (let i = 0; i < n; i++) {
        const name = this.seatOrder[(dealerIdx + i) % this.seatOrder.length];
        if (ready.includes(name)) positions[name] = labels[Object.keys(positions).length];
      }
    } else {
      // 4+ players: BTN, SB, BB, then positional names working backwards from BTN
      // First find BTN, SB, BB by walking forward from dealer
      const ordered = [];
      for (let i = 0; i < this.seatOrder.length; i++) {
        const name = this.seatOrder[(dealerIdx + i) % this.seatOrder.length];
        if (ready.includes(name)) ordered.push(name);
      }
      // ordered[0] = BTN, [1] = SB, [2] = BB, rest = action positions
      positions[ordered[0]] = 'BTN';
      positions[ordered[1]] = 'SB';
      positions[ordered[2]] = 'BB';

      const middle = ordered.slice(3); // players between BB and BTN (in action order after BB)
      const m = middle.length;
      if (m === 1) {
        positions[middle[0]] = 'UTG';
      } else if (m === 2) {
        positions[middle[0]] = 'UTG';
        positions[middle[1]] = 'CO';
      } else if (m === 3) {
        positions[middle[0]] = 'UTG';
        positions[middle[1]] = 'MP';
        positions[middle[2]] = 'CO';
      } else if (m === 4) {
        positions[middle[0]] = 'UTG';
        positions[middle[1]] = 'UTG+1';
        positions[middle[2]] = 'MP';
        positions[middle[3]] = 'CO';
      } else if (m === 5) {
        positions[middle[0]] = 'UTG';
        positions[middle[1]] = 'UTG+1';
        positions[middle[2]] = 'MP';
        positions[middle[3]] = 'HJ';
        positions[middle[4]] = 'CO';
      } else {
        // 6+ middle players (9+ total) — rare, just number them
        for (let i = 0; i < m; i++) {
          if (i === 0) positions[middle[i]] = 'UTG';
          else if (i === m - 1) positions[middle[i]] = 'CO';
          else if (i === m - 2) positions[middle[i]] = 'HJ';
          else if (i === m - 3) positions[middle[i]] = 'MP';
          else positions[middle[i]] = `UTG+${i}`;
        }
      }
    }
    return positions;
  }

  // ── State getters ─────────────────────────────

  getState(forPlayer) {
    // Returns full state. If forPlayer specified, only show their cards.
    const players = this._getPlayersState(false, forPlayer);
    const currentActor = this._currentPlayerIdx >= 0
      ? this.seatOrder[this._currentPlayerIdx]
      : null;

    return {
      phase: this.phase,
      paused: !!this._paused,
      handNumber: this.handNumber,
      pot: this.pot,
      communityCards: [...this.communityCards],
      players,
      actions: [...this.actions],
      currentActor,
      dealerSeat: this.dealerSeat,
      positions: this.getPositions(),
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      autoStart: this.autoStart,
      currentBet: this._currentBet,
      timestamp: Date.now(),
    };
  }

  getPlayerState(playerName) {
    // Returns state from one player's perspective (only their own cards visible)
    const state = this.getState(playerName);
    const p = this.players.get(playerName);

    state.myCards = p ? [...p.cards] : [];
    state.myStack = p ? p.stack : 0;
    state.isMyTurn = this.seatOrder[this._currentPlayerIdx] === playerName;

    if (state.isMyTurn) {
      const callAmount = Math.min(this._currentBet - (p?.bet || 0), p?.stack || 0);
      state.callAmount = Math.max(0, callAmount);
      const maxTotal = (p?.stack || 0) + (p?.bet || 0);
      state.minRaise = Math.min(this._currentBet + this._minRaise, maxTotal);
      state.maxRaise = maxTotal;
    }

    return state;
  }

  _getPlayersState(showAll, forPlayer) {
    return this.seatOrder.map(name => {
      const p = this.players.get(name);
      const obj = {
        name: p.name,
        seat: p.seat,
        stack: p.stack,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        sittingOut: p.sittingOut,
        isMe: name === forPlayer,
      };
      // Cards: show own cards always, show all at showdown
      if (showAll || name === forPlayer) {
        obj.cards = [...p.cards];
      }
      return obj;
    });
  }
}

// ── Exports ─────────────────────────────────────
module.exports = {
  PokerEngine,
  evaluateHand,
  compareHands,
  makeDeck,
  shuffleDeck,
  RANKS,
  SUITS,
};
