// coach-bridge.js — Browser-injected CoachBot bridge
// Injected into PokerNow game page via Chrome MCP javascript_tool.
// Hooks the page's existing WebSocket to capture all game events,
// maintains live game state, and exposes window.__coach API for CC.
//
// Usage (from CC):
//   javascript_tool(tabId, <contents of this file>)   // inject once
//   javascript_tool(tabId, `JSON.stringify(__coach.state)`)  // read state
//   javascript_tool(tabId, `__coach.act('fold')`)     // execute action
//   javascript_tool(tabId, `__coach.stopPolling()`)   // cleanup

(function () {
  'use strict';

  // Prevent double injection
  if (window.__coach) {
    window.__coach._log('Already injected, re-initializing...');
    window.__coach.stopPolling();
  }

  // ── State ──────────────────────────────────────
  const state = {
    phase: 'waiting',       // waiting|preflop|flop|turn|river|showdown
    myCards: [],            // ['Ah', 'Kd']
    communityCards: [],     // ['Qc', '7s', '2h']
    pot: 0,
    myStack: 0,
    mySeat: null,
    myName: '',
    myId: '',               // playerId
    dealer: null,
    smallBlind: 0,
    bigBlind: 0,
    currentBet: 0,
    myBetThisRound: 0,
    isMyTurn: false,
    callAmount: 0,
    minRaise: 0,
    maxRaise: 0,
    players: [],            // [{id, seat, name, stack, bet, folded, gameStatus, cards, isMe}]
    actions: [],            // [{actor, action, amount, phase}] accumulated per hand
    results: [],            // [{winner, amount}]
    handNumber: 0,
    lastEvent: '',          // last event name for debugging
    _actionKeys: {},        // dedup set (object keys, since Set doesn't JSON.stringify)
  };

  // Raw frame from server (deep-merged across updates)
  let frame = null;

  // Polling interval ID
  let pollingId = null;

  // Reference to the hooked WebSocket
  let hookedWs = null;

  // Log buffer (last N messages for debugging)
  const logs = [];
  const MAX_LOGS = 50;

  function log(msg) {
    const entry = new Date().toISOString().substring(11, 19) + ' ' + msg;
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.shift();
  }

  // ── WebSocket Hook ─────────────────────────────
  // Find and hook the page's existing WebSocket connection to PokerNow

  // Track which WS instances have been hooked (WeakSet avoids memory leaks)
  const hookedInstances = typeof WeakSet !== 'undefined' ? new WeakSet() : { add(){}, has(){ return false; } };

  // Saved reference to original send — used to restore after hook
  let origSend = null;

  function hookWebSocket() {
    // Strategy 1: Hook WebSocket.prototype.send to find the active connection
    origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (this.url && this.url.includes('pokernow.com') && !hookedInstances.has(this)) {
        hookExistingWs(this);
        log('Hooked existing WS via send intercept');
      }
      return origSend.call(this, data);
    };

    // Strategy 2: Hook WebSocket constructor for future connections
    const OrigWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
      if (url && url.includes('pokernow.com')) {
        hookExistingWs(ws);
        log('Hooked new WS via constructor');
      }
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;

    // Fallback: if registered event was missed, detect playerId from DOM
    detectPlayerIdFromDOM();
    log('WebSocket hooks installed, waiting for activity...');
  }

  // ── Detect playerId from DOM (fallback for missed registered event) ──
  function detectPlayerIdFromDOM() {
    // Retry a few times in case page hasn't fully rendered
    let attempts = 0;
    const maxAttempts = 10;
    const interval = setInterval(function () {
      attempts++;
      if (state.myId) {
        clearInterval(interval);
        return;
      }
      if (attempts > maxAttempts) {
        clearInterval(interval);
        log('detectPlayerIdFromDOM: gave up after ' + maxAttempts + ' attempts (myId will be set on next registered event)');
        return;
      }

      // PokerNow marks the user's player element with "you-player" class
      const youEl = document.querySelector('.you-player');
      if (!youEl) return;

      // Extract player name from the element text
      // The text contains: cards + name + stack, e.g. "27Select10Kdd7cc测试1000"
      // Look for the name label specifically
      const nameEl = youEl.querySelector('.table-player-name');
      const playerName = nameEl ? nameEl.textContent.trim() : null;

      if (playerName && state.players.length > 0) {
        // Match by name against known players
        const me = state.players.find(function (p) {
          return p.name === playerName || p.name.includes(playerName);
        });
        if (me) {
          state.myId = me.id;
          state.myName = me.name;
          state.mySeat = me.seat;
          state.myStack = me.stack;
          me.isMe = true;
          log('PlayerId from DOM (name match): ' + state.myId);
          clearInterval(interval);
          return;
        }
      }

      // Fallback: the you-player has visible (flipped) cards, others don't
      // Find the player whose cards we can see in the DOM
      const allPlayerEls = document.querySelectorAll('.table-player');
      for (var i = 0; i < allPlayerEls.length; i++) {
        var el = allPlayerEls[i];
        if (el.classList.contains('you-player')) {
          // Extract seat number from class: "table-player-1" → seat 1
          var seatMatch = el.className.match(/table-player-(\d+)/);
          if (seatMatch) {
            var seatNum = Number(seatMatch[1]);
            // Match seat to playerId via frame data
            if (frame && frame.seats && Array.isArray(frame.seats)) {
              for (var j = 0; j < frame.seats.length; j++) {
                if (Array.isArray(frame.seats[j]) && frame.seats[j][0] === seatNum) {
                  state.myId = frame.seats[j][1];
                  var me2 = state.players.find(function (p) { return p.id === state.myId; });
                  if (me2) { me2.isMe = true; state.myName = me2.name; state.myStack = me2.stack; state.mySeat = seatNum; }
                  log('PlayerId from DOM (seat match): ' + state.myId);
                  clearInterval(interval);
                  return;
                }
              }
            }
          }
        }
      }
    }, 500);
  }

  function hookExistingWs(ws) {
    // Prevent double-hooking the same WS instance
    if (hookedInstances.has(ws)) return;
    hookedInstances.add(ws);

    hookedWs = ws;

    // Preserve the page's existing onmessage handler (PokerNow may rely on it)
    const origOnMessage = ws.onmessage;

    ws.addEventListener('message', function (event) {
      try {
        handleRawMessage(event.data);
      } catch (e) {
        log('Error processing message: ' + e.message);
      }
      // Call original handler if it existed and was replaced
      if (origOnMessage && ws.onmessage !== origOnMessage) {
        try { origOnMessage.call(ws, event); } catch (e2) { /* page handler error */ }
      }
    });

    // On close: reset hookedWs so the next WS (reconnect) gets hooked
    ws.addEventListener('close', function () {
      log('WS closed — waiting for reconnect');
      if (hookedWs === ws) hookedWs = null;
    });

    log('WS message listener attached');
  }

  // ── Message Parsing (Engine.IO v3 + Socket.IO) ─
  // Same protocol as poker-now.js but adapted for browser
  function handleRawMessage(raw) {
    if (!raw || raw.length === 0) return;
    const eioType = raw[0];

    if (eioType === '4') {
      // Socket.IO message
      handleSIOPacket(raw.substring(1));
    }
    // Ignore ping/pong/open/close — browser WS handles those
  }

  function handleSIOPacket(data) {
    if (!data || data.length === 0) return;
    const sioType = data[0];

    if (sioType === '2') {
      // SIO EVENT — the main one
      parseSIOEvent(data.substring(1));
    }
  }

  function parseSIOEvent(data) {
    let jsonStr = data;
    // Strip optional ack ID prefix
    const ackMatch = data.match(/^(\d+)(\[.+)/s);
    if (ackMatch) jsonStr = ackMatch[2];

    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const eventName = parsed[0];
        const args = parsed.slice(1);
        state.lastEvent = eventName;
        processEvent(eventName, args);
      }
    } catch (e) {
      // Non-JSON event, ignore
    }
  }

  // ── Event Processing (from game-state.js) ──────
  function processEvent(eventName, args) {
    const data = args[0];

    switch (eventName) {
      case 'change':
      case 'gC':
        handleChange(data);
        break;
      case 'registered':
        handleRegistered(data);
        break;
      case 'nEM':
        handleEventMessage(data);
        break;
      case 'failed':
        log('Action failed: ' + JSON.stringify(data));
        break;
    }
  }

  function handleChange(data) {
    if (!data || typeof data !== 'object') return;

    if (!frame) {
      frame = data;
    } else {
      deepMerge(frame, data);
    }
    parseFrame(frame);
  }

  function handleRegistered(data) {
    if (!data) return;

    if (data.currentPlayer) {
      state.myId = data.currentPlayer.id || state.myId;
      log('Registered as player: ' + state.myId);
    }
    if (data.gameState) {
      frame = data.gameState;
      parseFrame(frame);
    }
  }

  function handleEventMessage(data) {
    if (!data) return;
    let text = null;
    if (typeof data === 'string') {
      text = data;
    } else if (typeof data === 'object') {
      text = data.msg || data.message || data.text || data.value || null;
      if (!text && Array.isArray(data.log)) {
        data.log.forEach(function (entry) {
          if (typeof entry === 'string') accumulateAction(entry);
        });
      }
    }
    if (text && typeof text === 'string') accumulateAction(text);
  }

  // ── Deep Merge with "<D>" deletion ─────────────
  function deepMerge(target, source) {
    for (const key of Object.keys(source)) {
      const val = source[key];
      if (val === '<D>') {
        delete target[key];
      } else if (val && typeof val === 'object' && !Array.isArray(val)
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
        deepMerge(target[key], val);
      } else {
        target[key] = val;
      }
    }
  }

  // ── Frame Parsing ──────────────────────────────
  function parseFrame(f) {
    if (!f) return;
    const prevTurn = state.isMyTurn;

    // New hand detection
    if (f.gN !== undefined && f.gN !== state.handNumber && state.handNumber > 0) {
      // Push summary of the previous hand before clearing
      if (state.actions.length > 0 || state.results.length > 0) {
        var summary = {
          event: 'handResult',
          hand: state.handNumber,
          myCards: state.myCards.slice(),
          board: state.communityCards.slice(),
          actions: state.actions.slice(),
          results: state.results.slice(),
          players: state.players.map(function (p) {
            var sp = { name: p.name };
            if (p.cards && p.cards.length > 0) sp.cards = p.cards.slice();
            if (p.folded) sp.folded = true;
            return sp;
          })
        };
        pushToServer('/event', summary);
        log('Hand #' + state.handNumber + ' summary pushed (' + state.actions.length + ' actions, ' + state.results.length + ' results)');
      }
      log('New hand: #' + f.gN);
      state.actions = [];
      state._actionKeys = {};
      state.results = [];
      state.communityCards = [];
      state.myCards = [];
      state.isMyTurn = false;
      state.phase = 'preflop';
    }
    if (f.gN !== undefined) state.handNumber = f.gN;

    // Basic game info
    state.pot = Number(f.pot) || 0;
    state.bigBlind = Number(f.bigBlind) || 0;
    state.smallBlind = Number(f.smallBlind) || 0;
    state.dealer = f.dealerSeat != null ? f.dealerSeat : state.dealer;

    // Players
    if (f.players) parsePlayers(f.players, f.seats || [], f);

    // Hole cards (pC)
    if (f.pC) parseCards(f.pC);

    // Community cards (oTC)
    if (f.oTC) {
      const board = [];
      for (const key of Object.keys(f.oTC)) {
        const cards = f.oTC[key];
        if (Array.isArray(cards)) {
          cards.forEach(function (c) { if (typeof c === 'string') board.push(c); });
        }
      }
      if (board.length > 0) state.communityCards = board;
    }

    // Phase
    updatePhase(f);

    // Events data (action history)
    if (f.eventsData && Array.isArray(f.eventsData)) {
      f.eventsData.forEach(function (ev) {
        if (typeof ev === 'string') accumulateAction(ev);
      });
    }

    // Turn detection
    detectMyTurn(f);

    // Update tab title + push state to local server
    if (state.isMyTurn && !prevTurn) {
      document.title = '\uD83D\uDD34 YOUR TURN | Poker Now';
      log('My turn! cards=' + state.myCards.join(',') + ' pot=' + state.pot);
      pushToServer('/turn', getState());
    } else if (!state.isMyTurn && prevTurn) {
      document.title = 'Poker Now - Poker with Friends';
    }

    // Push state on phase change or new hand
    var prevPhase = state._prevPhase || '';
    if (state.phase !== prevPhase) {
      state._prevPhase = state.phase;
      pushToServer('/state', getState());
      if (state.phase === 'preflop' && prevPhase && prevPhase !== 'waiting') {
        // New hand started — log it
        pushToServer('/event', { event: 'newHand', hand: state.handNumber, myCards: state.myCards });
      }
    }
  }

  function updatePhase(f) {
    const cc = state.communityCards.length;
    const status = f.status || '';

    if (status === 'waiting' || status === 'starting') {
      state.phase = 'waiting';
    } else if (cc === 0) {
      state.phase = 'preflop';
    } else if (cc === 3) {
      state.phase = 'flop';
    } else if (cc === 4) {
      state.phase = 'turn';
    } else if (cc >= 5) {
      state.phase = 'river';
    }

    if (f.gT && Array.isArray(f.gT)) {
      if (f.gT[1] === 5) state.phase = 'showdown';
    }
  }

  function parsePlayers(playersObj, seats, f) {
    if (!playersObj || typeof playersObj !== 'object') return;

    const tableBets = f.tB || {};
    const gameStatuses = f.pGS || {};
    const seatMap = {};

    if (Array.isArray(seats)) {
      seats.forEach(function (entry) {
        if (Array.isArray(entry) && entry.length >= 2) {
          seatMap[entry[1]] = entry[0];
        }
      });
    }

    state.players = [];

    for (const [pid, p] of Object.entries(playersObj)) {
      const gs = gameStatuses[pid] || p.gameStatus || '';
      const bet = tableBets[pid];
      const player = {
        id: pid,
        seat: seatMap[pid] != null ? seatMap[pid] : null,
        name: p.name || pid,
        stack: Number(p.stack) || 0,
        bet: typeof bet === 'number' ? bet : (Number(p.currentBet) || 0),
        status: p.status || '',
        gameStatus: gs,
        folded: gs === 'fold',
        cards: [],
        isMe: pid === state.myId,
      };

      if (pid === state.myId) {
        state.myName = p.name || '';
        state.mySeat = player.seat;
        state.myStack = player.stack;
        state.myBetThisRound = player.bet;
      }

      state.players.push(player);
    }
  }

  function parseCards(pC) {
    if (!pC || typeof pC !== 'object') return;

    // My hole cards
    if (state.myId && pC[state.myId]) {
      let myCardData = pC[state.myId];
      if (!Array.isArray(myCardData) && myCardData.cards) myCardData = myCardData.cards;
      if (Array.isArray(myCardData)) {
        state.myCards = myCardData
          .map(function (c) { return (typeof c === 'object' && c.value) ? c.value : c; })
          .filter(function (c) { return c && typeof c === 'string'; });

        const me = state.players.find(function (p) { return p.id === state.myId; });
        if (me) me.cards = state.myCards;
      }
    }

    // Other player cards (visible at showdown)
    state.players.forEach(function (player) {
      if (player.id !== state.myId && pC[player.id]) {
        let cardData = pC[player.id];
        if (!Array.isArray(cardData) && cardData.cards) cardData = cardData.cards;
        if (Array.isArray(cardData)) {
          player.cards = cardData
            .map(function (c) { return (typeof c === 'object' && c.value) ? c.value : c; })
            .filter(function (c) { return c && typeof c === 'string'; });
        }
      }
    });
  }

  function detectMyTurn(f) {
    if (!state.myId) { state.isMyTurn = false; return; }

    const pITT = f.pITT;
    if (pITT && pITT === state.myId) {
      state.isMyTurn = true;
      calculateActionParams(f);
      return;
    }
    if (pITT !== undefined) {
      state.isMyTurn = false;
      return;
    }

    // Fallback
    const meRaw = f.players && f.players[state.myId];
    if (meRaw && meRaw.actionStartedAt && meRaw.gameStatus === 'inGame') {
      state.isMyTurn = true;
      calculateActionParams(f);
    } else {
      state.isMyTurn = false;
    }
  }

  function calculateActionParams(f) {
    const tableBets = f.tB || {};
    const myBetRaw = tableBets[state.myId];
    const myBet = typeof myBetRaw === 'number' ? myBetRaw : state.myBetThisRound;
    const highestBet = Number(f.cHB) || 0;

    let maxBet = highestBet;
    if (!maxBet) {
      for (const val of Object.values(tableBets)) {
        if (typeof val === 'number' && val > maxBet) maxBet = val;
      }
    }
    if (!maxBet) {
      state.players.forEach(function (p) {
        if (p.bet > maxBet) maxBet = p.bet;
      });
    }

    state.callAmount = Math.max(0, maxBet - myBet);
    state.currentBet = maxBet;
    state.myBetThisRound = myBet;

    const bb = state.bigBlind || 20;
    state.minRaise = Number(f.mR) || Math.max(maxBet + bb, maxBet * 2);
    state.maxRaise = state.myStack + myBet;
    if (state.minRaise > state.maxRaise) state.minRaise = state.maxRaise;
  }

  // ── Action Parsing ─────────────────────────────
  function parseActionString(str) {
    let m;
    if ((m = str.match(/(.+?)\s+folds?/i)))
      return { actor: m[1].trim(), action: 'fold', amount: 0, phase: state.phase };
    if ((m = str.match(/(.+?)\s+calls?\s+(\d+)/i)))
      return { actor: m[1].trim(), action: 'call', amount: Number(m[2]), phase: state.phase };
    if ((m = str.match(/(.+?)\s+raises?\s+(?:to\s+)?(\d+)/i)))
      return { actor: m[1].trim(), action: 'raise', amount: Number(m[2]), phase: state.phase };
    if ((m = str.match(/(.+?)\s+checks?/i)))
      return { actor: m[1].trim(), action: 'check', amount: 0, phase: state.phase };
    if ((m = str.match(/(.+?)\s+bets?\s+(\d+)/i)))
      return { actor: m[1].trim(), action: 'bet', amount: Number(m[2]), phase: state.phase };
    if ((m = str.match(/(.+?)\s+(?:goes?\s+)?all[- ]?in\s*(?:with\s+)?(\d+)?/i)))
      return { actor: m[1].trim(), action: 'allin', amount: Number(m[2]) || 0, phase: state.phase };
    if ((m = str.match(/(.+?)\s+(?:wins?|collected|gains?)\s+(\d+)/i))) {
      state.results.push({ winner: m[1].trim(), amount: Number(m[2]) });
      return { actor: m[1].trim(), action: 'wins', amount: Number(m[2]), phase: 'showdown' };
    }
    return null;
  }

  function accumulateAction(text) {
    const parsed = parseActionString(text);
    if (parsed) {
      const key = parsed.actor + '|' + parsed.action + '|' + parsed.amount + '|' + parsed.phase;
      if (!state._actionKeys[key]) {
        state._actionKeys[key] = true;
        state.actions.push(parsed);
      }
    }
  }

  // ── Send Action via WebSocket ──────────────────
  function act(action) {
    if (!hookedWs || hookedWs.readyState !== WebSocket.OPEN) {
      return 'ERROR: WebSocket not connected';
    }

    // Parse action string: "fold", "check", "call", "raise 200"
    const parts = action.trim().toLowerCase().split(/\s+/);
    const cmd = parts[0];
    const amount = parts[1] ? Number(parts[1]) : null;

    const actionMap = {
      fold: 'PLAYER_FOLD',
      check: 'PLAYER_CHECK',
      call: 'PLAYER_CALL',
      raise: 'PLAYER_RAISE',
      bet: 'PLAYER_RAISE',
      allin: 'PLAYER_RAISE',
    };

    const type = actionMap[cmd];
    if (!type) return 'ERROR: Unknown "' + cmd + '"';

    const payload = { type: type };
    if (type === 'PLAYER_RAISE') {
      if (cmd === 'allin') {
        payload.value = state.maxRaise;
      } else if (amount) {
        payload.value = amount;
      } else {
        return 'ERROR: raise needs amount';
      }
    }

    const wsFrame = '42' + JSON.stringify(['action', payload]);
    hookedWs.send(wsFrame);
    log('Sent action: ' + wsFrame);
    pushToServer('/event', { event: 'myAction', hand: state.handNumber, phase: state.phase, action: cmd, amount: amount || 0 });
    return 'OK: ' + cmd + (amount ? ' ' + amount : '');
  }

  // ── Push state to local coach-server ───────────
  const COACH_SERVER = 'http://localhost:3456';
  function pushToServer(endpoint, data) {
    try {
      fetch(COACH_SERVER + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).catch(function () { /* server not running, silent */ });
    } catch (e) { /* silent */ }
  }

  // ── Host Commands via WebSocket ────────────────
  // pause, resume, stop (request/cancel)
  function host(cmd) {
    if (!hookedWs || hookedWs.readyState !== WebSocket.OPEN) {
      return 'ERROR: WebSocket not connected';
    }

    const hostMap = {
      pause:  { type: 'UP', socket: true },
      resume: { type: 'UR', socket: true },
      stop:   { type: 'TSG', decision: true, socket: true },
      cancelstop: { type: 'TSG', decision: false, socket: true },
    };

    const payload = hostMap[cmd];
    if (!payload) return 'ERROR: Unknown host command "' + cmd + '"';

    const wsFrame = '42' + JSON.stringify(['action', payload]);
    hookedWs.send(wsFrame);
    log('Sent host: ' + wsFrame);
    return 'OK: ' + cmd;
  }

  // ── Host Actions via HTTP (start-game, approve_player) ─
  function hostAction(endpoint, body) {
    const gameId = window.location.pathname.match(/\/games\/([^/]+)/);
    if (!gameId) return Promise.resolve('ERROR: not on a game page');

    return fetch('/games/' + gameId[1] + '/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.text().then(function (t) {
        return r.status === 200 ? 'OK' : 'ERROR: ' + r.status + (t ? ' ' + t : '');
      });
    });
  }

  // ── Fetch Game Log (player names, action history) ─
  function fetchLog() {
    const gameId = window.location.pathname.match(/\/games\/([^/]+)/);
    if (!gameId) return Promise.resolve({ error: 'not on a game page' });

    return fetch('/games/' + gameId[1] + '/log').then(function (r) {
      return r.json();
    }).then(function (data) {
      var logEntries = data.logs || [];
      // Extract player names from "Player stacks" or action lines
      // Format: "name @ playerId"
      var nameMap = {};
      logEntries.forEach(function (entry) {
        var matches = entry.msg.match(/"(.+?) @ (\w+)"/g);
        if (matches) {
          matches.forEach(function (m) {
            var parts = m.match(/"(.+?) @ (\w+)"/);
            if (parts) nameMap[parts[2]] = parts[1];
          });
        }
      });
      // Apply names to state.players
      var updated = 0;
      state.players.forEach(function (p) {
        if (nameMap[p.id] && (p.name === p.id || !p.name)) {
          p.name = nameMap[p.id];
          updated++;
          if (p.isMe) { state.myName = p.name; }
        }
      });
      if (state.myId && nameMap[state.myId] && !state.myName) {
        state.myName = nameMap[state.myId];
      }
      log('fetchLog: ' + Object.keys(nameMap).length + ' players found, ' + updated + ' names updated');
      return { nameMap: nameMap, logCount: logEntries.length };
    });
  }

  // ── Action Polling (poll coach-server for pending actions) ──
  let actionPollId = null;

  function startActionPoll() {
    if (actionPollId) return;
    actionPollId = setInterval(function () {
      fetch(COACH_SERVER + '/action').then(function (r) {
        return r.json();
      }).then(function (data) {
        if (data && data.action) {
          var actionStr = data.action;
          if (data.amount) actionStr += ' ' + data.amount;
          log('Action from server: ' + actionStr);
          var result = act(actionStr);
          // Report result back
          fetch(COACH_SERVER + '/action-result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: result.indexOf('OK') === 0, result: result }),
          }).catch(function () {});
        }
      }).catch(function () { /* server not running */ });
    }, 1000);
    log('Action polling started');
  }

  function stopActionPoll() {
    if (actionPollId) {
      clearInterval(actionPollId);
      actionPollId = null;
      log('Action polling stopped');
    }
  }

  // ── Polling (autoAdvice mode) ──────────────────
  let sharedAudioCtx = null;
  function startPolling() {
    if (pollingId) return 'Already polling';
    pollingId = setInterval(function () {
      if (state.isMyTurn) {
        // Notification sound (short beep) — reuse AudioContext
        try {
          if (!sharedAudioCtx) {
            sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
          }
          const osc = sharedAudioCtx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = 800;
          osc.connect(sharedAudioCtx.destination);
          osc.start();
          osc.stop(sharedAudioCtx.currentTime + 0.15);
        } catch (e) { /* silent fail */ }
      }
    }, 1000);
    log('Polling started');
    return 'OK';
  }

  function stopPolling() {
    if (pollingId) {
      clearInterval(pollingId);
      pollingId = null;
      log('Polling stopped');
    }
    stopActionPoll();
    document.title = 'Poker Now - Poker with Friends';
    return 'OK';
  }

  // ── Get clean state for CC (no internal fields) ─
  function getState() {
    // Deep copy to prevent CC from mutating live state
    const s = JSON.parse(JSON.stringify(state));
    delete s._actionKeys;
    delete s.lastEvent;
    delete s._prevPhase;
    return s;
  }

  // ── Expose API ─────────────────────────────────
  window.__coach = {
    state: state,                  // Live reference (always current)
    getState: getState,            // Clean copy for CC
    getPlayerId: function () { return state.myId; },
    act: act,                      // "fold", "check", "call", "raise 200", "allin"
    host: host,                    // "pause", "resume", "stop", "cancelstop", "kick"
    hostAction: hostAction,        // HTTP: hostAction('start-game', {}), hostAction('approve_player', {playerID, stackChange})
    fetchLog: fetchLog,            // Fetch game log → auto-populate player names, returns {nameMap, logCount}
    startPolling: startPolling,
    stopPolling: stopPolling,
    startActionPoll: startActionPoll,
    stopActionPoll: stopActionPoll,
    getLogs: function () { return logs.slice(); },
    isConnected: function () { return hookedWs && hookedWs.readyState === WebSocket.OPEN; },
    _log: log,
  };

  // ── Initialize ─────────────────────────────────
  hookWebSocket();
  startActionPoll();
  log('coach-bridge.js injected successfully');

})();
