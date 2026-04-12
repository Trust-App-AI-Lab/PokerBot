# Preflop Strategy

How to think about preflop decisions in 6-max cash games.

## The Core Question: Why Do We Play This Hand?

Every preflop decision comes down to: **does this hand make money in this spot?**

A hand's profitability depends on three things working together:
1. **Raw equity** — how often it wins at showdown vs the ranges you'll face
2. **Playability** — how well it navigates postflop (can it make nuts? flushes? straights? or does it make weak top pairs that are hard to play?)
3. **Position** — do you act last postflop? This is worth more than most people realize. A mediocre hand IP often outperforms a good hand OOP, because you get to see what villain does first on every street.

This is why A5s opens from UTG but A8o doesn't. A8o has higher raw equity, but A5s has nut flush potential, wheel straight draws, and blocks AA — it's far more *playable*. A8o just makes weak top pairs that get dominated by AK/AQ/AJ. Suitedness adds ~3-4% equity but much more importantly, it gives you nut potential and combo draw possibilities that let you play big pots confidently.

Similarly, 87s is better than K3s despite the lower high card. Connectivity = straight potential = postflop equity realization. K3s flops a weak king or nothing.

## Opening (RFI)

When no one has entered the pot, your choice is open-raise or fold. Never limp — you give up fold equity and play a bloated pot with a range disadvantage.

Use `preflop.py` to check the GTO frequency for your hand in this position. Output shows how often this hand opens — >50% means raise, <50% means fold, in between is a mixed strategy where you randomize.

**Why ranges widen by position:** UTG opens ~15%, BTN opens ~48%. This isn't arbitrary — from UTG you have 5 players left to act who might wake up with a strong hand, and you'll be OOP against most of them. From BTN you only face the blinds, and you have position on both. More hands are profitable when you have these advantages. For the deeper mechanics of why position matters so much — information advantage, equity realization, pot control — see `gto-fundamentals.md` Position section.

SB is an interesting case: it opens ~40%, tighter than BTN's ~48%, despite being "later." Why? Because SB is always OOP postflop vs BB. That positional disadvantage costs enough equity realization that you need a tighter range to compensate.

**Sizing:** 2.5BB standard. Smaller from BTN (2BB) because you have position and want calls from weaker ranges. Larger from EP (3BB) to discourage multiway pots where your tight range loses its edge. Add 1BB per limper.

**Mixed frequency hands:** Many hands near the boundary of your range are mixed — they raise sometimes and fold sometimes. This isn't indecision; it's game theory. If you always open a borderline hand, opponents can adjust. The frequency from `preflop.py` tells you how often GTO opens it.

## Facing a Raise

Someone opened. Now you're choosing between 3-bet, call, and fold, and the reasoning changes based on several factors.

### How to Think About 3-Betting

A 3-bet range needs both value and bluffs — if you only 3-bet premiums, opponents just fold everything except monsters and you never get action.

**Value hands** (QQ+, AKs, and mixed for JJ/TT/AQs) are straightforward — you want to build a pot because you're ahead of villain's continuing range.

**Bluff hands** are less obvious. The best 3-bet bluffs share specific properties:
- **Blockers to villain's strongest hands.** A5s blocks AA and AKs, directly reducing the combos that can 4-bet you. KJo blocks nothing important.
- **Playability when called.** If your bluff gets called, you want nut potential. A5s can make nut flushes and wheel straights. KJo makes dominated pairs and weak draws.
- **Not good enough to just call.** You're choosing between 3-bet and fold, not between 3-bet and call. Hands like JTs and 98s are profitable calls IP — you don't need to turn them into 3-bets.

This is why A5s/A4s/A3s are canonical 3-bet bluffs but KJo isn't, despite KJo looking "stronger."

### 3-Bet Frequency Depends on Leverage

You 3-bet tighter against EP opens (~6-8%) and wider against BTN opens (~12-15%). The logic: an UTG opener has a tight range that can withstand 3-bets (lots of QQ+, AK). A BTN opener has a wide range full of marginal hands that fold to pressure.

Your position matters too — from BTN you can 3-bet wider because you'll be IP postflop if called. From SB you 3-bet wider than BB because you can't profitably flat OOP (flatting SB is one of the biggest leaks at low stakes — you're OOP with a capped range).

When deciding whether to call or 3-bet, think about your equity against villain's opening range. You can run `equity.py` against a preset range (e.g., `"25%"` for a CO open, `"50%"` for a BTN open) to see where you stand. If your equity is high but your hand is too strong to just flat — 3-bet. If your equity is decent and you have position — call might be fine. Then `odds.py` tells you if the call is actually profitable given the pot odds.

### Calling (Flatting)

Flatting works when your hand is good enough to play but not good enough to 3-bet, and **you have position**. Mid pairs (77-TT), suited broadways (KJs, QJs), suited connectors (98s, 87s) — these hands realize equity well IP but poorly OOP.

BB is the exception: you're getting a discount (already posted 1BB), so you can defend wider even though you're OOP. The pot odds math makes a huge difference — vs a 2.5BB open, you need 27% equity to call, and most suited hands clear that bar.

## Facing a 3-Bet

You opened, villain 3-bet. Most of your opening range should fold — this is normal and correct. 3-bet pots are expensive, and continuing with marginal hands OOP is a major leak.

The key question is: does my hand have enough equity against villain's 3-bet range to justify the price? Run `equity.py` against a tight range (~5-10% depending on villain's position) to find out. Then `odds.py` with the pot and call amount tells you if continuing is +EV.

**4-bet for value** — AA, KK always. QQ and AKs mostly. You're building a huge pot with the top of your range.

**4-bet as a bluff** — A5s (blocks AA), occasionally A4s/A3s. Very low frequency. You're representing the same range as your value 4-bets, and if villain folds, you win a big pot with air.

**Call** — JJ, TT (especially IP), AKo, AQs. These hands have enough equity to continue but not enough to build a 4-bet pot. Some suited connectors if stacks are deep enough for implied odds.

**Why folding most of your range is fine:** You opened with ~27% of hands from CO. Villain 3-bet, representing ~10%. Your JTs, K9s, 65s — these were profitable opens against random hands in the blinds, but against a 3-bet range they're losing money. Folding them isn't weak; it's correct.

**4-bet sizing:** 2.2-2.5x the 3-bet. Villain 3-bets to 9BB → you make it 20-22BB. At 100BB effective, this usually commits you to calling a 5-bet shove.

## Facing a 4-Bet

This is the simplest spot because the decision space collapses. SPR after the flop will be ~1-2, meaning you're essentially committed preflop.

Either your hand is strong enough to get stacks in (AA, KK always; QQ, AKs against wide 4-bettors) → 5-bet all-in. Or it isn't → fold. Calling and seeing a flop at SPR 1-2 with a marginal hand is lighting money on fire.

If you 4-bet bluffed and got 5-bet, respect it and fold. Your bluff didn't work.

## BB Defense

BB is unique because you already have 1BB invested. Vs a 2.5BB open, you're calling 1.5BB to win 4BB — only 27% pot odds needed. This discount fundamentally changes which hands are profitable. Use `odds.py` to verify this in specific spots — the discount often makes hands profitable that you'd never play otherwise.

Against a BTN open (~48% range), GTO defends ~55-65%. That's incredibly wide — almost any suited hand, any pair, most broadways. The reasoning: villain's range is so wide that even your weak hands have enough equity, and the price is so good that folding is giving up too much. You can verify with `equity.py` — even something like T6s has ~38% equity against a `"50%"` range, which easily clears the 27% pot odds threshold.

Against an EP open (~15% range), tighten dramatically to ~30-35% defense. Same pot odds, but villain's range is much stronger, so your weak hands don't have the equity to justify calling.

The defense splits into 3-bet (~12-15% vs BTN) and call (~40-50% vs BTN). Your 3-bet range follows the same value+bluff logic described above, just wider because villain's opening range is weaker.

## SB vs BB

When folded to SB, it's heads-up. SB opens ~40% (raise or fold — never limp in GTO). BB defends very wide (~60-70%) and 3-bets more frequently (~15-18%) because SB's range is so wide that more hands qualify as value 3-bets.

## Multi-way Pots

With multiple players in the pot, two things change:
1. **Your equity drops** — you need a stronger hand to beat 3 opponents vs 1. Tighten significantly.
2. **Fold equity drops** — bluff 3-bets and squeezes work less often because someone in the pot probably has a real hand.

But draws gain implied odds — when you hit with multiple opponents, the pot grows fast.

## Thinking Principles

These aren't rules to memorize — they're consequences of the logic above:

- **Position > cards** — a consequence of information advantage, equity realization, and pot control (see `gto-fundamentals.md` for the full reasoning)
- **Suited > offsuit** — a consequence of playability, nut potential, and combo draws
- **Connectedness > high cards** — a consequence of straight potential and postflop equity
- **Respect 3-bets from EP** — a consequence of tight opening ranges being resilient
- **Folding is free** — calling and losing isn't. When in doubt preflop, folding is rarely a big mistake; calling with trash often is.
