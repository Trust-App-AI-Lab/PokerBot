# GTO Fundamentals

Core concepts of Game Theory Optimal poker. This is the theoretical foundation
that all other strategy docs build on.

## What GTO Means

GTO is the strategy that **cannot be exploited**. If you play GTO perfectly,
no opponent can gain an edge over you regardless of how they play. In practice,
we approximate GTO as a baseline and deviate (exploit) when we spot weaknesses.

## Ranges, Not Hands

Never think "villain has AK." Think "villain's range in this spot is roughly
{AA-TT, AKs-ATs, KQs, AKo-AJo} — about 8% of hands."

Every action you take must be consistent with what your *entire range* would do
in this spot, not just your specific hand. If you only bet the nuts on the river,
you become exploitable (villain just folds everything except the nuts).

## Balance: Value and Bluffs

Every betting range should contain both value bets and bluffs. The ratio
is determined by your bet sizing:

- If you bet **B** into a pot of **P**, villain needs to call and be right
  more than **B / (P + 2B)** of the time.
- Your bluff frequency should make villain indifferent to calling.

| Bet Size (% pot) | Value % | Bluff % |
|-------------------|---------|---------|
| 33%               | 71%     | 29%     |
| 50%               | 67%     | 33%     |
| 66%               | 62%     | 38%     |
| 75%               | 60%     | 40%     |
| 100%              | 50%     | 50%     |
| 150%              | 43%     | 57%     |

## Minimum Defense Frequency (MDF)

When facing a bet, you must defend (call or raise) at least:

**MDF = 1 - [bet / (pot + bet)]**

If you defend less than MDF, opponent profits by bluffing any two cards.

| Facing Bet Size   | MDF   |
|-------------------|-------|
| 33% pot           | 75%   |
| 50% pot           | 67%   |
| 66% pot           | 60%   |
| 75% pot           | 57%   |
| 100% pot          | 50%   |
| 150% pot          | 40%   |

**But**: MDF is a guideline, not a rule. If villain never bluffs, fold more.
If villain over-bluffs, call more. MDF is only "correct" against a balanced opponent.

## Polarization

As streets progress, betting ranges become more **polarized**:

- **Flop**: Merged ranges — bet top pair, draws, some bluffs, check medium hands
- **Turn**: More polarized — bet strong value + draws, check medium
- **River**: Fully polarized — bet only nuts/strong value OR pure bluffs. Never bet "medium" hands.

Why? Medium hands on the river gain nothing from betting — worse hands fold,
better hands call. They belong in the checking range.

## Range Advantage vs Nut Advantage

Two different concepts, both matter:

- **Range advantage**: Whose range is *on average* stronger on this board?
  - Example: Preflop raiser has range advantage on A-K-7 rainbow (has more Ax, Kx)
  - Effect: Can bet more frequently, even with weak hands

- **Nut advantage**: Who can have the *very best* hands?
  - Example: BB has nut advantage on 7-6-5 (has more 98, 43, 77, 66, 55)
  - Effect: Can make large bets / check-raises

When you have both → bet frequently with large sizing.
When you have range advantage but not nut advantage → bet small, high frequency.
When you have neither → check most of your range.

## Indifference Principle

At equilibrium, many hands are **indifferent** between actions — the EV of calling
equals the EV of folding. This is why mixed strategies exist. When a hand is
truly indifferent, the *frequency* you choose doesn't change your EV, but it
changes your opponent's ability to exploit you.

In practice: if a hand feels like a "close decision," it's probably a mixed
strategy spot. Use the frequency from the chart rather than agonizing over
the "right" answer — both actions have the same EV.

## Exploitative Adjustments

GTO is the baseline. Deviate when you have evidence:

| Villain Tendency | Exploit |
|------------------|---------|
| Folds too much to c-bets | Bluff c-bet more, value bet less |
| Calls too much | Value bet thinner, cut bluffs |
| Never bluffs river | Fold more vs river bets (below MDF is fine) |
| Over-bluffs river | Call wider than MDF |
| Doesn't 3-bet enough | Open wider, don't fear 3-bets |
| 3-bets too much | Tighten opens, add 4-bet bluffs |
| Limps frequently | Raise wider for isolation |
| Passive postflop | Bet wider for value, bluff less |
| Hyper-aggressive | Trap more, let them bluff into you |

**Key rule**: Only exploit when you have clear evidence. Against unknowns,
stick to GTO. A small GTO edge is better than a big exploit that's wrong.
