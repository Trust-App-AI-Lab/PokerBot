const fs = require('fs');

const HISTORY_SCHEMA = 'pokerbot.history.v1';

const ACT_NAME = {
  call: 'call',
  check: 'check',
  fold: 'fold',
  bet: 'bet',
  raise: 'raise',
  small_blind: 'sb',
  big_blind: 'bb',
};

function appendJsonl(filePath, event, onError) {
  const ordered = {
    ts: new Date().toISOString(),
    schema: HISTORY_SCHEMA,
    ...event,
  };
  try {
    fs.appendFileSync(filePath, JSON.stringify(ordered) + '\n');
  } catch (err) {
    if (onError) onError(err);
  }
}

function handStartedEvent({ hand, blinds, positions, players }) {
  return {
    type: 'hand.started',
    hand,
    blinds,
    positions: positions || {},
    players: players || {},
  };
}

function playerActionEvent(hand, action, fallbackPhase) {
  const actor = action.actor || action.player || '';
  const verb = action.action || action.type || '';
  const event = {
    type: 'player.action',
    hand,
    actor,
    action: verb,
    phase: action.phase || fallbackPhase || '',
  };
  if (action.amount != null) event.amount = action.amount;
  if (action.chat) event.chat = action.chat;
  return event;
}

function streetDealtEvent({ hand, phase, cards, board }) {
  return {
    type: 'street.dealt',
    hand,
    phase: phase || '',
    cards: Array.isArray(cards) ? cards : [],
    board: Array.isArray(board) ? board : Array.isArray(cards) ? cards : [],
  };
}

function handEndedEvent({ hand, results, payouts, shown, shownCards, stacks, pot, board }) {
  const event = {
    type: 'hand.ended',
    hand,
    results: results || [],
    shown: shown || [],
    stacks: stacks || {},
  };
  if (payouts) event.payouts = payouts;
  if (shownCards) event.shownCards = shownCards;
  if (pot != null) event.pot = pot;
  if (board) event.board = board;
  return event;
}

function formatAction(ev) {
  if (typeof ev.action === 'string' && !ev.actor) return ev.action;
  const verb = ACT_NAME[ev.action] || ev.action || '';
  return ev.amount != null && ev.amount !== ''
    ? `${ev.actor} ${verb} ${ev.amount}`
    : `${ev.actor} ${verb}`.trim();
}

function normalizeActionEvent(ev) {
  if (ev.type === 'action') {
    return {
      type: 'player.action',
      hand: ev.hand,
      actor: ev.actor || '',
      action: ev.action,
      text: ev.action,
      phase: ev.phase || '',
      amount: ev.amount,
      ts: ev.ts,
    };
  }
  return {
    type: 'player.action',
    hand: ev.hand,
    actor: ev.actor || ev.player || '',
    action: ev.action || '',
    phase: ev.phase || '',
    amount: ev.amount,
    chat: ev.chat,
    ts: ev.ts,
  };
}

function eventType(ev) {
  return String(ev && ev.type || '');
}

function reconstructHands(events) {
  const hands = [];
  let cur = null;

  for (const ev of events || []) {
    const type = eventType(ev);
    if (type === 'hand_start' || type === 'hand.started') {
      cur = {
        hand: ev.hand,
        blinds: ev.blinds,
        positions: ev.positions || {},
        players: ev.players || {},
        actions: [],
        actionEvents: [],
        board: [],
      };
      if (ev.ts) cur.ts = ev.ts;
      continue;
    }

    if ((type === 'action' || type === 'player.action') && cur && ev.hand === cur.hand) {
      const actionEvent = normalizeActionEvent(ev);
      cur.actionEvents.push(actionEvent);
      cur.actions.push(actionEvent.text || formatAction(actionEvent));
      continue;
    }

    if ((type === 'board' || type === 'street.dealt') && cur && ev.hand === cur.hand) {
      if (Array.isArray(ev.board) && ev.board.length) cur.board = [...ev.board];
      else if (Array.isArray(ev.cards)) {
        if (type === 'street.dealt' && cur.board.length && ev.cards.length <= 2) cur.board.push(...ev.cards);
        else cur.board = [...ev.cards];
      }
      continue;
    }

    if ((type === 'hand_end' || type === 'hand.ended') && cur && ev.hand === cur.hand) {
      cur.results = ev.results || [];
      if (ev.payouts) cur.payouts = ev.payouts;
      cur.shown = ev.shown || [];
      if (ev.shownCards) cur.shownCards = ev.shownCards;
      cur.stacks = ev.stacks || {};
      if (ev.pot != null) cur.pot = ev.pot;
      if (Array.isArray(ev.board) && ev.board.length) cur.board = [...ev.board];
      if (ev.ts) cur.endedAt = ev.ts;
      hands.push(cur);
      cur = null;
    }
  }

  if (cur) {
    cur.incomplete = true;
    hands.push(cur);
  }

  return hands;
}

function eventsForHands(events, hands) {
  const handNums = new Set((hands || []).map(hand => hand.hand));
  return (events || []).filter(ev => handNums.has(ev.hand));
}

function filterRawEventsForPlayer(events, playerName) {
  if (!playerName) return events;
  return (events || []).map(ev => {
    const type = eventType(ev);
    if ((type === 'hand_start' || type === 'hand.started') && ev.players) {
      const filtered = { ...ev, players: {} };
      for (const [name, pData] of Object.entries(ev.players)) {
        filtered.players[name] = name === playerName ? pData : [[], pData[1]];
      }
      return filtered;
    }
    if (type === 'hand_end' || type === 'hand.ended') {
      const copy = { ...ev };
      delete copy.shown;
      return copy;
    }
    return ev;
  });
}

module.exports = {
  HISTORY_SCHEMA,
  appendJsonl,
  handStartedEvent,
  playerActionEvent,
  streetDealtEvent,
  handEndedEvent,
  reconstructHands,
  eventsForHands,
  filterRawEventsForPlayer,
};
