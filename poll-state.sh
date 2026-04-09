#!/bin/bash
# poll-state.sh — Read game state once, output parsed JSON
curl -s http://localhost:3456/state 2>/dev/null | node -e "
  const s=JSON.parse(require('fs').readFileSync(0,'utf8'));
  const me=s.players.find(p=>p.name==='Enyan')||{};
  console.log(JSON.stringify({
    hand:s.handNumber, phase:s.phase, myTurn:s.isMyTurn,
    cards:(s.myCards||[]).join(' '), board:(s.communityCards||[]).join(' '),
    pot:s.pot, stack:s.myStack, currentBet:s.currentBet,
    myBet:me.bet||0, position:(s.positions||{}).Enyan||'',
    folded:me.folded||false, actor:s.currentActor||'',
    players:s.players.map(p=>({n:p.name,s:p.stack,f:p.folded,b:p.bet}))
  }));
"
