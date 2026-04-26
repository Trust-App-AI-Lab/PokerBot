---
name: poker-strategy
description: >
  PokerBot internal dependency — GTO poker calculation tools and strategy docs. This is a pure internal component that should NEVER be triggered directly by users. Only coachbot and bot-management SKILLs call this SKILL's tools (equity, odds, preflop, evaluator) and strategy docs during analysis/decisions. If the user asks "EV多少" or "胜率", that triggers coachbot, not this SKILL.
author: EnyanDai
version: 2.0.0
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

# Poker Strategy — Router

## Tools

| Tool | Use when... | Example call | Returns |
|------|-------------|--------------|---------|
| `preflop`   | Open / 3-bet / call decision for a hand + position | `python .claude/skills/poker-strategy/tools/preflop.py Ah Ks BTN`           | `Action: RAISE · Raise: 100% · Fold: 0%` (GTO freq) |
| `equity`    | % win vs a villain range (optional board)          | `python .claude/skills/poker-strategy/tools/equity.py Ah Kh "QQ+" Td 7d 2c` | `Equity: 16.5% · Win: 16.5% · Tie: 0% · Lose: 83.5%` |
| `odds`      | Is this call +EV given pot / call / equity?        | `python .claude/skills/poker-strategy/tools/odds.py 200 50 0.35`            | `need_equity: 20% · ev: +37.5 · profitable: True` |
| `evaluator` | Final hand rank from 5–7 cards                     | `python .claude/skills/poker-strategy/tools/evaluator.py Ah Kh Qh Jh Th`    | `Royal Flush (class=9, tiebreak=(12,))` |

Each tool also accepts `--help` for full arg list.

## Strategy docs

Read on-demand from `.claude/skills/poker-strategy/strategy/<name>.md`:

| Doc | Read when wondering... |
|-----|------------------------|
| `preflop`          | "Is KQo a 3-bet vs BTN?" / "How wide do I defend BB vs CO?" |
| `postflop`         | "Who has range advantage on K72r?" / "C-bet this flop or check back?" |
| `sizing`           | "Why 1/3 pot here and not 2/3?" / "What bluff freq does half-pot allow?" |
| `gto-fundamentals` | "What's the MDF facing 2/3 pot?" / "When should I deviate from balance?" |
| `range`            | "What combos is villain continuing to barrel with?" / "Has their range capped?" |

## Card notation

Ranks `2-9 T J Q K A` · Suits `h d c s` · e.g. `Ah`=A♥ `Td`=T♦
