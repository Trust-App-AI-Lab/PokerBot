---
name: poker-agent
description: >
  GTO poker calculation tools. Required by CoachBot and play bots with "Use Tools: yes".
---

# Poker Agent — Tool Manual

All tools: `python3 poker-agent/tools/<tool>.py`. Prefix `PYTHONIOENCODING=utf-8` on Windows.

## preflop.py — GTO open-raise chart (6-max, 100BB)

```bash
python3 poker-agent/tools/preflop.py Ah Ks          # all positions
python3 poker-agent/tools/preflop.py 7h 6h CO        # one position
```
```
Hand: 76s | Position: CO | Action: RAISE | Raise: 100% | Fold: 0%
```
- 100% = always raise, 0% = always fold, between = mixed (randomize)
- RFI only — facing a raise/3-bet is a different spot (see `strategy/preflop.md`)

## equity.py — Monte Carlo equity vs range

```bash
python3 poker-agent/tools/equity.py Ah Kh "QQ+,AKs" --sims 10000
python3 poker-agent/tools/equity.py Ah Kh "20%" Td 7d 2c --sims 10000
python3 poker-agent/tools/equity.py Ac Tc random --sims 10000
```
```
Hero: Ah Kh | Villain: QQ+,AKs (15 combos) | Board: -
Equity: 38.0% | Win: 28.6% | Tie: 18.7% | Lose: 52.7%
```
- Presets: `5%` `10%` `15%` `20%` `25%` `30%` `40%` `50%` `random`
- ±1-2% at 10K sims. Use 50K for tight ranges.

## odds.py — Pot odds + EV

```bash
python3 poker-agent/tools/odds.py 200 50 0.35                 # pot call equity
python3 poker-agent/tools/odds.py 200 50 0.20 --implied 300   # with implied odds
```
```
Pot Odds: 20.0% (1:4.0) | Need equity: 20.0%
EV of call (equity=35%): +37.5 | Profitable: True
Implied (future=300): need 9.1% equity, effective pot=550
```
- **Decision**: equity (from equity.py) ≥ need_equity → call is +EV

## evaluator.py — Hand ranking (5-7 cards)

```bash
python3 poker-agent/tools/evaluator.py Ah Kh Qh Jh Th
python3 poker-agent/tools/evaluator.py As Kd 7c 7h 2s
```
```
Royal Flush (class=9)
One Pair (class=1)
```
- Classes: 0=High Card 1=Pair 2=Two Pair 3=Trips 4=Straight 5=Flush 6=Full House 7=Quads 8=Straight Flush 9=Royal Flush

## range_parser.py — Expand range notation

```bash
python3 poker-agent/tools/range_parser.py "QQ+, AKs, AJs+"
python3 poker-agent/tools/range_parser.py "QQ+, AKs" Ah Kd Tc   # dead cards
```
Usually not needed directly — equity.py calls it internally.

## Strategy Docs

| When | Read |
|------|------|
| Preflop (facing raise, 3-bet, squeeze) | `poker-agent/strategy/preflop.md` |
| Postflop (any street) | `poker-agent/strategy/postflop.md` |
| Bet sizing | `poker-agent/strategy/sizing.md` |
| Core GTO concepts | `poker-agent/strategy/gto-fundamentals.md` |
| Range estimation & reading | `poker-agent/strategy/range.md` |

## Card Notation

Ranks: `2-9 T J Q K A` — Suits: `h d c s` — Example: `Ah`=A♥ `Td`=T♦ `2c`=2♣
