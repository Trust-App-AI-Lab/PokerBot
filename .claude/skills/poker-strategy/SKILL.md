---
name: poker-strategy
description: >
  PokerBot internal dependency — GTO poker calculation tools and strategy docs. This is a pure internal component that should NEVER be triggered directly by users. Only coachbot and bot-management SKILLs call this SKILL's Python tools (equity.py, odds.py, preflop.py, evaluator.py) and strategy docs during analysis/decisions. If the user asks "EV多少" or "胜率", that triggers coachbot, not this SKILL.
author: EnyanDai
version: 1.0.0
tags:
  - poker
  - gto
  - strategy
  - tools
  - internal
metadata:
  openclaw:
    requires:
      bins:
        - python3
    install:
      - kind: pip
        package: numpy
---

# Poker Agent — Tool & Strategy Interface

This SKILL is the sole interface for GTO analysis. Callers (CoachBot, PlayBot) load this file via `/poker-strategy` — all tool paths and strategy doc paths are defined here and nowhere else.

## Tools

All tools: `python3 <SKILL_DIR>/tools/<tool>.py` (`<SKILL_DIR>` = this SKILL's directory). Prefix `PYTHONIOENCODING=utf-8` on Windows.

### preflop — GTO open-raise chart (6-max, 100BB)

```bash
python3 <SKILL_DIR>/tools/preflop.py Ah Ks          # all positions
python3 <SKILL_DIR>/tools/preflop.py 7h 6h CO        # one position
```
```
Hand: 76s | Position: CO | Action: RAISE | Raise: 100% | Fold: 0%
```
- 100% = always raise, 0% = always fold, between = mixed (randomize)
- RFI only — facing a raise/3-bet is a different spot (see strategy doc `preflop`)

### equity — Monte Carlo equity vs range

```bash
python3 <SKILL_DIR>/tools/equity.py Ah Kh "QQ+,AKs" --sims 10000
python3 <SKILL_DIR>/tools/equity.py Ah Kh "20%" Td 7d 2c --sims 10000
python3 <SKILL_DIR>/tools/equity.py Ac Tc random --sims 10000
```
```
Hero: Ah Kh | Villain: QQ+,AKs (15 combos) | Board: -
Equity: 38.0% | Win: 28.6% | Tie: 18.7% | Lose: 52.7%
```
- Presets: `5%` `10%` `15%` `20%` `25%` `30%` `40%` `50%` `random`
- ±1-2% at 10K sims. Use 50K for tight ranges.

### odds — Pot odds + EV

```bash
python3 <SKILL_DIR>/tools/odds.py 200 50 0.35                 # pot call equity
python3 <SKILL_DIR>/tools/odds.py 200 50 0.20 --implied 300   # with implied odds
```
```
Pot Odds: 20.0% (1:4.0) | Need equity: 20.0%
EV of call (equity=35%): +37.5 | Profitable: True
Implied (future=300): need 9.1% equity, effective pot=550
```
- **Decision**: equity (from equity) ≥ need_equity → call is +EV

### evaluator — Hand ranking (5-7 cards)

```bash
python3 <SKILL_DIR>/tools/evaluator.py Ah Kh Qh Jh Th
python3 <SKILL_DIR>/tools/evaluator.py As Kd 7c 7h 2s
```
```
Royal Flush (class=9)
One Pair (class=1)
```
- Classes: 0=High Card 1=Pair 2=Two Pair 3=Trips 4=Straight 5=Flush 6=Full House 7=Quads 8=Straight Flush 9=Royal Flush

### range_parser — Expand range notation

```bash
python3 <SKILL_DIR>/tools/range_parser.py "QQ+, AKs, AJs+"
python3 <SKILL_DIR>/tools/range_parser.py "QQ+, AKs" Ah Kd Tc   # dead cards
```
Usually not needed directly — equity calls it internally.

## Strategy Docs

Strategy docs are in `<SKILL_DIR>/strategy/`, loaded by tier.

### Tier Definitions

| Tier | Docs | Used By |
|------|------|---------|
| **fish** | (none) | fish-level bots |
| **regular** | `preflop`, `postflop`, `range` | regular-level bots |
| **shark** | ALL 5: `gto-fundamentals`, `preflop`, `postflop`, `sizing`, `range` | shark-level bots |
| **pro** | ALL 5 (same as shark) | pro-level bots, CoachBot |

### Doc Coverage

| Doc | Covers |
|-----|--------|
| `preflop` | RFI, facing raise/3-bet/squeeze |
| `postflop` | Board texture, range advantage, nut advantage, c-bet |
| `sizing` | Geometric sizing, SPR, polarized vs merged, bluff-to-value ratio |
| `gto-fundamentals` | Balance, MDF, polarization, position, indifference, exploitation |
| `range` | Street-by-street range narrowing, combo counting, opponent profiling |

## Card Notation

Ranks: `2-9 T J Q K A` — Suits: `h d c s` — Example: `Ah`=A♥ `Td`=T♦ `2c`=2♣
