---
name: poker-agent
description: >
  GTO-based poker strategy agent with calculation tools. Two modes:
  PlayBot (autonomous play) and TeachBot (coaching/review).
  Trigger: poker agent, poker策略, 打牌, play poker, teach poker,
  牌局分析, hand review, 教我打牌, GTO
---

# Poker Agent — GTO Strategy + Tools

A GTO-oriented poker decision engine with two operating modes, backed by calculation tools.
Works alongside `pokernow-bot` (connection layer) but is **fully independent** —
can analyze any hand, not just live PokerNow games.

## Architecture

```
poker-agent/
├── SKILL.md            ← You are here. Workflow + tool reference.
├── tools/              ← Deterministic calculation tools
│   ├── evaluator.py    ← Hand ranking (5-7 cards → best hand)
│   ├── preflop.py      ← GTO preflop ranges by position (6-max, 100BB)
│   ├── range_parser.py ← Range notation → concrete combos
│   ├── equity.py       ← Monte Carlo equity (hand vs range)
│   └── odds.py         ← Pot odds, EV, SPR, implied odds
└── strategy/           ← Strategy knowledge base (READ before deciding)
    ├── gto-fundamentals.md  ← Core GTO concepts: balance, MDF, polarization
    ├── preflop.md           ← Preflop decision trees by scenario
    ├── postflop.md          ← Street-by-street postflop reasoning
    └── sizing.md            ← Bet sizing theory and heuristics
```

**IMPORTANT:** Before making any decision, read the relevant strategy docs.
Pre-flop hand? Read `strategy/preflop.md`. Post-flop spot? Read `strategy/postflop.md`.
Unsure about sizing? Read `strategy/sizing.md`. These docs contain the actual poker knowledge.

## Modes

### PlayBot — Autonomous Play

Claude reads game state and outputs the best action.

**Workflow:**
1. Read game state (from `pokernow-bot` turn file or manual input)
2. Pre-compute with tools: GTO preflop advice, pot odds, SPR
3. Read relevant strategy doc(s)
4. Reason through decision, calling tools as needed (equity vs range, etc.)
5. Apply mixed strategy when GTO calls for it
6. Output action: fold / check / call / raise [amount]

**Usage:**
```
"帮我打这手牌" / "play this hand"
"I have AhKs, board is Td7d2c, pot 200, villain bets 100. What should I do?"
```

### TeachBot — Coaching Mode

Claude watches the user play and gives feedback after each decision.

**Workflow:**
1. Read game state + user's actual action
2. Run the same decision process independently
3. Compare Claude's GTO recommendation vs user's actual play
4. Feedback:
   - Match GTO → confirm, explain why it's correct
   - Deviate from GTO → explain the GTO play, evaluate if the exploit was reasonable
   - Always frame in ranges and frequencies, not just "good/bad"

**Usage:**
```
"帮我看牌" / "coach me" / "teach mode"
"我翻前拿到JTo在UTG open了3BB，你觉得怎么样？"
"Review this hand: I called a 3-bet with 76s OOP, good or bad?"
```

## Tools Reference

All tools are CLI scripts in `poker-agent/tools/`. Run from project root.

### Pre-flop GTO Ranges
```bash
python poker-agent/tools/preflop.py Ah Ks           # all positions
python poker-agent/tools/preflop.py 7h 6h CO         # specific position
python poker-agent/tools/preflop.py Jc To UTG        # specific position
```

### Equity Calculator (hand vs range)
```bash
python poker-agent/tools/equity.py Ah Kh "QQ+, AKs" --sims 10000
python poker-agent/tools/equity.py Ah Kh "20%" Td 7d 2c --sims 10000
```
Preset ranges: `5%`, `10%`, `15%`, `20%`, `25%`, `30%`, `40%`, `50%`

### Pot Odds & EV
```bash
python poker-agent/tools/odds.py 200 50 0.35
python poker-agent/tools/odds.py 200 50 0.20 --implied 300
```

### Range Parser
```bash
python poker-agent/tools/range_parser.py "QQ+, AKs, AJs+"
python poker-agent/tools/range_parser.py "QQ+, AKs" Ah Kd Tc   # with dead cards
```

### Hand Evaluator
```bash
python poker-agent/tools/evaluator.py Ah Kh Qh Jh Th
```

## Decision Workflow (Quick Reference)

This is the process outline. The *substance* lives in `strategy/`.

1. **Assess** — Phase, position, stack depth, action tree (no tools needed)
2. **Preflop?** — `preflop.py` → frequencies; consult `strategy/preflop.md` for scenario
3. **Postflop?** — Estimate villain range (agent reasoning); consult `strategy/postflop.md`
4. **Calculate** — `equity.py` for equity vs range; `odds.py` for pot odds / EV
5. **Size** — Consult `strategy/sizing.md`
6. **Decide** — Integrate math + strategy + reads → action
