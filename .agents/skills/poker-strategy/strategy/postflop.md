# Postflop Strategy

How to think through postflop decisions, street by street. Read `gto-fundamentals.md` first for core concepts (polarization, MDF, range advantage, position).

## The Postflop Thinking Loop

Every decision on every street comes back to the same questions:

1. **What's villain's range?** Not "what hand does villain have" — what's the *set of hands* consistent with everything they've done so far? Each action narrows this. An open-raise is ~20% of hands. A flop call removes the top (would've raised) and bottom (would've folded). By the river, villain's range might be 30-50 specific combos.

2. **How does my hand relate to that range?** Am I ahead of most of it, behind most of it, or drawing to beat it? This is where `equity.py` is valuable — not as a fixed answer, but as a sanity check. If you think you're "probably ahead" but equity says 35%, your read is off.

3. **Who has the structural advantage?** Range advantage, nut advantage, and position (see `gto-fundamentals.md` for all three) determine who should be betting and how big. These come from how ranges interact with the board and who acts last, not from your specific hand.

4. **What does the math say?** Equity, pot odds, EV. Run the numbers when it's close — human intuition is bad at pot odds. `odds.py` takes the guesswork out of "should I call this bet?"

## Reading the Board

The board texture tells you everything about how ranges interact. This isn't classification for its own sake — it directly determines strategy.

**Dry boards** (K-7-2 rainbow, A-8-3 rainbow): Few draws exist. Hand strength is mostly locked in — what's ahead now will probably still be ahead on the river. The preflop raiser's range (weighted toward high cards) connects more often, giving them range advantage. This means they can bet small and very frequently — villain's range is mostly weak, and even a small bet pressures hands that can't call.

**Wet boards** (J-T-8 two-tone, 9-8-7, Q-J-9 with flush draw): Draws everywhere. Equity shifts constantly — a hand that's behind on the flop might be a favorite by the turn. The caller often has an advantage here because their range has more suited connectors and small pairs that hit these textures. The raiser needs to bet bigger to charge draws and protect value, but also checks more because their overcards and big pairs are vulnerable.

**Paired boards** (K-K-5, 8-8-3): Almost nobody hit trips. The preflop raiser's range advantage is massive because they have more of the high cards and the caller's range mostly whiffed. Bet small, bet often — villain will fold a ton because they simply can't have anything.

**Monotone boards** (Ks-9s-4s): The twist here is that the *caller* usually has more suited hands than the raiser (they flat with suited connectors, suited broadways). So the raiser actually has less nut advantage than usual. Check more as raiser. When you do bet, go bigger — you need to charge flush draws.

The key insight: board texture isn't a label you apply, it's a way of understanding how two ranges collide. A "wet" board doesn't mean "bet big" mechanically — it means equity is volatile and draws exist, which *implies* you need bigger bets to protect and charge.

## The Flop

### Thinking About C-Bets

The decision to c-bet is primarily about range dynamics, not your specific hand. Ask:

- **Do I have range advantage here?** If yes, I can bet frequently with my whole range — strong hands, weak hands, draws, air. The bet makes money because villain folds too much in aggregate.
- **Do I have nut advantage?** If yes, I can go bigger. If villain can't have the nuts, I can put in large bets and they can't effectively raise.
- **How many opponents?** Multi-way pots kill c-betting because *someone* probably connected. Go from 60-70% c-bet frequency heads-up to 30-40% three-way.

Your specific hand matters last. On a K-7-2 rainbow board, you c-bet AK (top pair top kicker) and you c-bet T9s (nothing, but it doesn't matter — your range owns this board and a small bet prints money).

On a 7-6-5 two-tone board, your range advantage disappears. Your AK is basically air here. You need real hands or draws to bet, and you bet bigger when you do.

### Facing a C-Bet (as IP Caller)

Your range is capped — you called preflop, so you (usually) don't have AA/KK. Think about:

- **Can my hand improve?** Draws and medium pairs that can turn sets are good calls. Dead hands with no draw should fold.
- **Is the pot odds math there?** Run `equity.py` against villain's c-betting range (which is wide — they c-bet most of their range on many boards), then `odds.py` to see if calling is +EV.
- **Should I raise?** Raising means you need sets, two pair, or strong draws. Mix in some raises with combo draws (flush + straight draw) — if you only raise the nuts, villain just folds everything but the nuts.

### Playing OOP as BB Defender

The hardest spot in poker. You're out of position with the widest, weakest range at the table. For why position creates such a fundamental disadvantage — information asymmetry, equity realization, pot control — see `gto-fundamentals.md` Position section. Here we focus on the practical responses.

**Default: check to the raiser.** They have range advantage on most boards, so let them bet and react.

**Check-raise** is your most powerful weapon OOP. It compensates for your positional disadvantage by building a big pot when you're strong. But it only works if you also check-raise with bluffs — otherwise villain just folds when you raise. A balanced check-raise range has:
- Value: sets, two pair, overpairs on safe boards
- Semi-bluffs: combo draws, open-ended straight draws
- Occasional pure bluffs: backdoor draws, gutshots that need fold equity

The frequency (~8-12% on the flop) is low because you're mostly check-calling or check-folding. But it's essential — without it, villain can c-bet with impunity.

**Donk betting** (leading into the raiser) is almost always wrong. It's only correct on boards that heavily favor *your* range — like 5-6-7 when you defended BB with suited connectors and villain opened from EP with big cards. These spots are rare.

## The Turn

### What Changed?

The turn card either changed everything or nothing, and knowing which is the key to turn play.

Ask: **did this card help villain's range or mine?** If the turn completes a flush draw that villain's range has more of, that changes your strategy even if it doesn't affect your specific hand. Conversely, if the turn is a brick that changes nothing, your flop reasoning still applies.

### Double Barreling

After c-betting the flop, you need a reason to bet again. The pot is bigger now, and villain has already shown some strength by calling the flop. Good reasons:

- **You improved** — turned a pair, picked up a draw, made a set
- **The turn card is a scare card for villain** — an overcard, a completing draw card. Even if it doesn't help *you*, it threatens *villain's* range and gives your bet credibility
- **Your range still has advantage** — the turn didn't change the dynamics, so the same logic that made you bet the flop still applies

Bad reasons to double barrel:
- "I already bet the flop so I should keep going" — that's not reasoning, that's autopilot
- You have showdown value — checking controls the pot and lets villain bluff

### Facing a Turn Bet

Villain's turn bet is more credible than their flop bet because they chose to bet again after you showed strength by calling. Their range is narrower and stronger.

This is a critical spot to run the math. Estimate what range villain would bet the turn with (top pair+, strong draws usually), run `equity.py` to see where you stand, and check `odds.py` for whether calling is profitable. If equity says 30% and you need 25% — it's a call. If equity says 20% and you need 30% — it's a fold, even if it "feels" like you should call.

Continue with: top pair good kicker+, strong draws (8+ outs), hands with meaningful implied odds. Fold: weak pairs with no draw, gutshots facing large bets. Raise: only with very strong hands or draws that have both equity and fold equity.

## The River

### Everything Simplifies

No more cards coming. No more drawing. No more "potential." It's pure hand strength, and ranges become fully polarized — villain is either betting strong hands for value or missed draws as bluffs. There's no middle ground, because betting a medium hand on the river gains nothing (worse folds, better calls).

### Betting the River

Three questions:
1. **Can worse hands call?** → Value bet. The thinner you value bet, the more you can bluff. Against a calling station, bet thin (even top pair). Against a nit, don't — they only call with better.
2. **Can better hands fold?** → Bluff. But choose your bluffs carefully. The best bluffs are missed draws that **block villain's calling range** — e.g., a missed flush draw where you hold a card that blocks villain's sets. The worst bluffs block villain's *folding* range (the hands that would fold anyway).
3. **Neither?** → Check. You have showdown value. Betting turns your hand into a bluff, and it's a bad bluff because it blocks nothing useful.

### Facing a River Bet

Villain's river bet is polarized: they have it or they don't. You need a **bluff catcher** — a hand that beats all bluffs but loses to all value.

The question isn't "do I have a good hand?" but "given the pot odds, am I getting the right price against villain's bluffing frequency?" This is where `odds.py` is essential. If villain bets pot, you need 33% equity — meaning villain needs to be bluffing at least 33% of the time. MDF says you should call with ~50% of your range facing a pot-sized bet.

When choosing which bluff catchers to call with, prefer hands that **block villain's value** (reduce the combos they can have for value) and **unblock villain's bluffs** (don't reduce the combos they'd bluff with).

## How Ranges Narrow (Street by Street)

Tracking how both players' ranges change with each action is the most important skill in postflop poker. Each action is a filter — bets/raises keep strong hands + bluffs and remove the middle, calls keep medium hands + draws, checks signal weakness (with occasional traps).

This filtering happens symmetrically: villain's actions narrow their range, and YOUR actions narrow your range in villain's eyes. A double barrel tells villain you're either strong or committed to a bluff. A check after c-betting tells villain your flop bet was likely weak.

For the full treatment — three filters explained, street-by-street narrowing for both sides, common action patterns (triple barrel, bet-bet-check, check-call-check-call), and how to use this with tools — see `range.md`. The postflop sections above give you the decision framework; `range.md` gives you the range tracking engine that powers it.
