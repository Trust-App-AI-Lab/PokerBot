# Postflop Strategy

Street-by-street reasoning framework. Read `gto-fundamentals.md` first for
core concepts (polarization, MDF, range advantage).

## General Postflop Process

Every street follows the same reasoning loop:
1. **What does villain's range look like?** (Narrow based on all prior actions)
2. **How does my hand interact with that range?** (Ahead, behind, or drawing?)
3. **Who has range/nut advantage on this board?**
4. **What action best serves my whole range in this spot?** (Not just this hand)
5. **Run the math** — equity vs range, pot odds, EV of each action

## Board Texture Classification

Before anything else, read the board:

### Dry Boards
Examples: K-7-2 rainbow, A-8-3 rainbow, Q-6-2 two-tone
- Few draws possible
- Ranges are more static (hand strength won't change much)
- Favors preflop raiser (range advantage with more high cards)
- Strategy: High frequency small bets. Villain's range is mostly weak here.

### Wet Boards
Examples: J-T-8 two-tone, 9-8-7, Q-J-9 with flush draw
- Many draws, connected cards
- Ranges are dynamic (equity shifts every street)
- Often favors caller (more suited connectors, small pairs that hit sets)
- Strategy: Larger bets with more polarized range. Protect value, charge draws.

### Paired Boards
Examples: K-K-5, 8-8-3, A-7-7
- Very few combos hit trips
- Range advantage heavily to preflop raiser
- Strategy: Small bet very frequently. Villain will fold a ton.

### Monotone Boards
Examples: Ks-9s-4s, Th-7h-3h
- One player likely has a flush draw, but made flushes are rare
- Having the nut flush draw is critical
- Strategy: Check more as preflop raiser (caller has more suited hands).
  When betting, use larger sizes.

## The Flop

### As Preflop Raiser (IP or OOP)

**C-bet decision factors:**
1. Board texture (see above)
2. Range advantage — do I want to bet frequently?
3. Number of opponents — c-bet less in multi-way pots
4. My specific hand — but this matters less than range factors

**C-bet strategy patterns:**

| Board Type | Frequency | Sizing | Why |
|------------|-----------|--------|-----|
| Dry, high (A/K high) | 70-80% | 25-33% pot | Range advantage. Small bet, high freq. |
| Dry, low (7-5-2) | 40-50% | 50-66% pot | Less range advantage. Selective, bigger. |
| Wet, connected | 40-60% | 60-75% pot | Charge draws. More polarized. |
| Paired | 70-90% | 25-33% pot | Almost always bet small. |
| Monotone | 30-40% | 50-75% pot | Check more. When betting, go bigger. |
| Multi-way (3+) | 30-40% | 50-75% pot | Much tighter. Need real value or good draws. |

### As Preflop Caller (IP)

- You called preflop → your range is capped (no AA/KK usually)
- If villain checks → can bet (delayed c-bet / stab), but don't overdo it
- If villain c-bets:
  - Call with draws + medium hands that can improve
  - Raise with sets/two pair + some strong draws (for balance)
  - Fold garbage — but respect MDF

### As BB Defender (OOP)

- Hardest spot in poker. OOP with a wide range.
- Check to raiser most of the time
- **Donk bet**: Only on boards that heavily favor your range (e.g., 5-6-7 when you defended with suited connectors). Very rare in GTO.
- **Check-raise**: Important weapon. Use with sets, two pair, combo draws. Mix in some bluffs (gutshots, backdoor draws).
- **Check-call**: Medium strength hands. Top pair weak kicker, second pair, draws with OK equity.
- **Check-fold**: Missed hands with no equity or draw.

### Check-Raise Construction (OOP)

A balanced check-raise range needs:
- **Value**: Sets, two pair, overpairs on safe boards
- **Semi-bluffs**: Combo draws (flush draw + straight draw), open-ended straight draws
- **Pure bluffs (small frequency)**: Backdoor draws, hands you want to protect from being outdrawn

**Frequency**: Check-raise about 8-12% of the time on flop. Mostly check-call or check-fold.

## The Turn

### Key Differences from Flop
- One card closer to showdown → ranges narrow
- Draws either improved or got worse (lost an out street)
- Pot is bigger → mistakes are more costly
- Strategy becomes more polarized

### Double Barrel (Betting Turn After Flop C-Bet)

**Bet when:**
- You improved (turned a pair, made a set, picked up a draw)
- Your range still has advantage (turn card doesn't change dynamics)
- Turn card is a scare card for villain's calling range (overcard, completing draw card — even if it doesn't help you, it threatens villain)
- You have a strong draw with equity + fold equity

**Check when:**
- You have showdown value but can't handle a raise
- Turn card helped villain's range more than yours
- Pot is big enough, control the size
- You want to induce bluffs from villain's missed draws

### Facing a Turn Bet

- Ranges are narrower here. Villain's turn bet means more than their flop bet.
- Continue with: top pair top kicker+, strong draws (8+ outs), hands with implied odds
- Fold: weak pairs with no draw, gutshots facing large bets
- Raise: only with very strong hands or strong draws with fold equity

## The River

### Key Differences from Turn
- No more cards coming. Pure hand strength.
- Ranges should be fully polarized (see `gto-fundamentals.md`)
- Betting medium-strength hands for value = mistake (worse folds, better calls)
- Bluffs should be hands with zero showdown value (missed draws)

### River Betting Decision Tree

**Do I bet?**
1. Can worse hands call? → Value bet
2. Can better hands fold? → Bluff
3. Neither → Check (showdown value)

**Value bet thickness:**
- Against a station (calls too much): Bet thin — two pair, even top pair good kicker
- Against a nit (folds too much): Don't thin value bet — they only call with better
- GTO: Bet value at a frequency that balances with your bluffs at the right ratio for your sizing

**Bluff selection:**
- **Best bluffs**: Missed draws that block villain's calling range
  - Example: missed flush draw that blocks villain's sets (you have the 9s, board has 9)
  - Example: AQ on K-J-T-4-2 (you block AK, KQ, QJ — villain's value hands)
- **Worst bluffs**: Hands that block villain's folding range
  - Example: don't bluff with a hand that blocks villain's missed draws (those are hands that would fold anyway)

### Facing a River Bet

- MDF applies but use judgment
- Villain's river betting range is polarized → you need bluff catchers
- A bluff catcher is a hand that beats all bluffs but loses to all value
- If you have multiple bluff catchers in your range, you only need to call with some of them (not all)
- Choose to call with bluff catchers that **block villain's value** and **unblock villain's bluffs**

## Range Narrowing Reference

How to estimate villain's range street by street:

**Preflop:**
- Open from UTG → top 15%. Open from BTN → top 48%.
- 3-bet from BB vs BTN → top ~12-15% (polarized: premium + bluffs)
- Cold call → suited broadways, mid pairs, suited connectors

**Flop (after preflop raise, villain checks/calls):**
- Checked → exclude most strong hands (would bet), exclude air (would fold)
- Called a bet → medium+: top pair weak kicker, mid pair, draws
- Raised → very strong (sets, two pair) + strong draws (combo draws)

**Turn (after flop call):**
- Bet-called flop → remove air, narrow to: top pair good kicker+, strong draws
- Checked flop then bet turn → often draws that improved, or delayed c-bet with medium strength

**River:**
- If villain bet all three streets: very narrow, heavily polarized
  - Value side: sets+, sometimes top pair top kicker
  - Bluff side: missed draws
- If villain check-called three streets: capped at medium strength (would have raised with strong hands)
