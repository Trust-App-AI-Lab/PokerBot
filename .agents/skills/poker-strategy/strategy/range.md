# Range Thinking

How to think about ranges — both your opponent's and your own — and how to make
decisions when your hand sits at the boundary of a range.

## Why Ranges, Not Hands

"I think he has AK" is almost always wrong. There are 1,326 possible starting hands,
and you're guessing one? The right way to think is: "given everything he's done so far,
what *set of hands* is consistent with his actions?"

This applies to both sides of the table. You're estimating what villain could have, and
villain is estimating what you could have. Every action either of you takes narrows both
ranges simultaneously. A river bet from villain makes his range more polarized — and your
call or fold reveals information about your range too.

`equity.py` lets you test your hand against any range. But the tool is only as good as
the range you feed it — garbage in, garbage out. This document is about building good
range estimates, for both sides.

## Preflop: Where Ranges Begin

### Villain's Starting Range

The first range estimate comes from the preflop action. Position is the biggest factor —
earlier positions open tighter because more players are left to act behind.

| Position | Approximate open range | Why |
|----------|----------------------|-----|
| UTG | ~15% | 5 players behind, need strong hands |
| HJ | ~18% | Slightly wider, one less opponent |
| CO | ~25% | Only BTN and blinds left |
| BTN | ~45-50% | Best position, only blinds to beat |
| SB | ~40% | Wide but OOP vs BB — slightly tighter than BTN |

Use `preflop.py` to check specific hands. When someone opens from UTG, immediately think
"tight, ~15%, lots of big pairs and big aces." When someone opens from BTN, think "wide,
~48%, could be almost anything suited or connected."

Other preflop actions further define the range:

**3-bet**: Much tighter and polarized — strong value plus carefully chosen bluffs.
Vs UTG open: ~4-5% (QQ+, AKs, some A5s/A4s). Vs BTN open: ~12-15% (88+, ATs+, KQs,
suited wheel aces). The bluffs are hands like A5s because they block AA, have nut flush
potential, and aren't profitable enough to just flat.

**Cold call (flat)**: Good enough to play but not to 3-bet, usually with position.
This is a **capped range** — missing the very strongest hands (which would have 3-bet).
Typical: mid pairs (66-TT), suited broadways (KJs, QJs, JTs), suited connectors (98s, 87s).

**Limp**: In full ring, signals a weak/passive player with a wide, unfocused range (~40-60%).
In heads-up, SB limps can be strategic and close to random.

**BB defense**: Very wide because of the discount (already posted 1BB). Vs BTN open,
BB defends 55-65%. This is the widest preflop range you'll face — on the flop BB can
have almost anything.

### Your Own Starting Range

At the same time, think about what YOUR range looks like to the opponent.

If you opened from CO, your range is ~25%. Villain knows this. If the flop comes A-7-2
and you c-bet, villain thinks "his 25% range has a lot of Ax hands and overpairs — this
c-bet is probably real." But if the flop comes 7-6-5 and you c-bet, villain thinks "his
range mostly missed here — this could be a bluff."

If you flat called preflop (didn't 3-bet), your range is capped. Villain knows you
probably don't have AA/KK/AK. On an A-high flop, your range is at a structural
disadvantage — you have fewer strong Ax hands than the preflop raiser.

The key: **your preflop action defines the story you're telling for the rest of the hand.
Every subsequent action needs to be consistent with that story.**

## Postflop: How Actions Filter Both Ranges

Each action on each street is a filter — it removes some hands and keeps others. This
applies symmetrically to both players.

### The Three Filters

**Bet/Raise → keeps strong hands + draws + bluffs, removes medium hands.**
When someone bets, they're putting money in. Medium hands (second pair, weak top pair)
usually just call — they're not confident enough to bet but too strong to fold. So a
betting range is weighted toward the top (value) and bottom (bluffs). This polarization
increases on later streets (see `gto-fundamentals.md` for the theory of polarization).

**Call → keeps medium hands + draws, removes the top and bottom.**
A call says "I have something, but not enough to raise." This removes monsters (would
have raised) and pure air (would have folded). What's left is the middle: pairs with
decent kickers, draws, some slow-played hands.

**Check → keeps weak hands + traps, removes most strong hands.**
When someone checks, most strong hands would have bet for value. So a checking range
is weighted toward weak hands — but watch out for traps, especially from good players.

These filters apply to YOU too. When you check the flop, villain removes most strong
hands from your range. If you then bet the turn, your "story" is: either you improved
on the turn, or you're making a delayed c-bet. Villain will evaluate your action against
that filtered range.

### Street-by-Street Narrowing

**Preflop → Flop**: The biggest filter. A CO open is ~25% of hands. Many miss the
flop entirely. If villain calls a c-bet, their range narrows to ~40-50% of their
preflop range — hands that connected (pair, draw, overcards with backdoors).

Meanwhile, YOUR range also narrows in villain's eyes. If you c-bet, villain knows you
could have value or bluffs. If you check, villain removes most of your strong hands.

**Flop → Turn**: Ranges get noticeably tighter. Villain called the flop so they had
something. A second bet pressures weak draws and marginal pairs into folding. What
remains: top pair+, strong draws (8+ outs), stubborn medium pairs.

Your range narrows too. A double barrel says "I'm still confident" — so your range
is weighted toward strong made hands and draws that picked up equity. If you check
after c-betting, you're revealing that your flop bet was likely a one-shot bluff or
a medium hand that doesn't want to invest more.

**Turn → River**: The final narrowing. Villain's range is heavily defined — if they've
called two streets, they almost certainly have top pair decent kicker+, or they were
drawing. On the river, draws either got there or bricked. Add flush combos if the card
hit; remove all flush draws if it bricked.

Your range is maximally defined too. A triple barrel is a very strong statement — either
you have a big hand or a pure bluff. Villain is evaluating your bluffing frequency for
this specific line (see `gto-fundamentals.md` for value-to-bluff ratios by bet size).

### Common Postflop Patterns

These patterns apply to BOTH players — learn to recognize them in villain's actions,
and be aware of what pattern you're creating with your own actions.

**Bet-bet-bet (triple barrel)**: Very polarized by the river. Either strong value
(two pair+, sets) or a pure bluff (missed draw). Medium hands don't bet three streets.
When YOU triple barrel, make sure your range contains both value and bluffs in a
balanced ratio — pure value gets no calls, pure bluffs get snapped off.

**Bet-bet-check**: Gave up on the river. Often a draw that missed, or medium-strength
value that doesn't want to face a raise. The checking range is capped — villain (or you)
can bet thin for value against it.

**Check-call, check-call**: Screams medium strength. Second pair, weak top pair,
sometimes a slow-played monster. Mostly medium hands that don't know what to do
except call and hope. When you notice this pattern in your own play, ask: should I
be check-raising some of these instead of always check-calling?

**Check-raise on flop**: Polarized. Either very strong (sets, two pair) or a semi-bluff
(combo draws, strong draws). On dry boards more weighted toward value; on wet boards
more semi-bluffs. When YOU check-raise, make sure you have both — pure value check-raises
are too transparent.

## Constructing Your Own Range

Estimating villain's range is half the picture. The other half: making sure your OWN
range in any given spot is coherent and balanced.

### Why It Matters

If you only bet the river with the nuts, villain just folds everything except better.
If you only check-raise with sets, villain folds whenever you raise. Your individual
hand exists inside a range of hands that would take the same action — if that range is
unbalanced, a good opponent exploits you.

The question: "if I take this action, what other hands in my range would also take
this action? Does the overall mix make sense?"

### Range Construction by Spot

Think backwards from the current decision. Every previous action already defines what
range you can have here.

**Example**: You opened from CO, BB called. Flop Q-7-3 rainbow. You c-bet, BB called.
Turn 5. You bet again.

Your double-barrel range should contain:
- **Value**: QQ/77/33 (sets), AQ/KQ (top pair good kicker), AA/KK (overpairs)
- **Bluffs**: AK/AJ (overcards that c-bet and barrel as semi-bluffs), hands with
  backdoor equity that picked up a gutshot or flush draw on the turn

If you ONLY barrel with strong made hands, your range is pure value — villain folds
everything except top pair+. You need bluffs to keep villain honest. But if you barrel
with too much air, villain profitably calls with any pair.

The right balance depends on your bet sizing — see `gto-fundamentals.md` for the
value-to-bluff ratio table, and `sizing.md` for how sizing connects to balance.

### The Coherence Test

Before acting, ask: **is this action consistent with my range in this spot?**

- **Almost all of your range would do this** → action is fine. Example: small c-bet
  on K-7-2 rainbow as preflop raiser. Your whole range benefits.
- **Only the very top of your range would do this** → too transparent. Add bluffs,
  or villain reads you easily.
- **Only bluffs would do this** → probably bad. No credible value hands take this line.

### Capped vs Uncapped

Your previous actions create a ceiling (or not) on your range:

- **Flat called preflop** → capped. Probably no AA/KK/AK. On A-high boards your range
  is structurally weaker than the raiser's.
- **Checked the flop** → capped at medium strength. A turn bet is either a delayed
  c-bet or an improved hand — villain evaluates accordingly.
- **3-bet preflop** → uncapped. You can have AA/KK plus bluffs. This wide gap lets
  you bet larger because your range supports polarized sizing.

**Make sure your story is coherent.** A passive preflop line followed by sudden river
aggression is a story that doesn't add up — good opponents notice.

## Mixed Strategies: Hands at the Range Boundary

Many spots don't have a single correct action. `preflop.py` might say "RAISE 65%" —
meaning GTO raises this hand 65% of the time and folds 35%. This is a mixed strategy.

For the theoretical foundation (indifference principle, why mixing prevents exploitation),
see `gto-fundamentals.md`. This section focuses on **how to think about and execute
mixing in practice**.

### Reading Mixed Frequencies

When `preflop.py` gives a frequency between 0% and 100%:

- **>80%**: Treat as "always." Only deviate with a specific reason.
- **50-80%**: Lean toward this action, but the alternative is fine. Let your read
  on the opponent tip the balance.
- **20-50%**: Genuine mix. Neither action is clearly better.
- **<20%**: Almost never. Only with a strong exploitative reason.

### When to Mix vs When to Commit

**Mix when**: the hand is near your range boundary, both actions have similar EV,
and you're against a competent opponent who will notice patterns.

**Commit when**: one action is clearly dominant, you have a strong read that tips
the scale, or your opponent is weak enough that they won't exploit your pattern —
in that case, just take the exploitatively best action every time.

### Executing Mixes

You can't flip a mental coin every hand. Use deterministic proxies:

- **Suit-based**: "3-bet if I have at least one heart, otherwise call." Suits are
  evenly distributed (~75/25 for "at least one of suit X"). For 50/50: "3-bet if
  my first card is red."
- **Time-based**: "Raise if current second is even, call if odd."
- **Board-based** (postflop): "Bluff if river card is red, check if black."

The method doesn't matter. What matters: your mixing is **uncorrelated with hand
strength**. If you only mix with medium hands and always commit with strong hands,
you're not really mixing — you're being transparent at the top of your range.

### Mixing in Postflop Spots

Mixing isn't just preflop open/fold. It applies everywhere you construct a range:

- **C-betting**: On some boards you bet your entire range (K-7-2 dry), on others
  you split (check some strong hands for trapping, bet some bluffs for balance).
  Which specific hands to check vs bet is a mix — and the right frequency depends
  on board texture and your sizing.

- **River bluffing**: You've arrived at the river with some missed draws. Which ones
  do you bluff with? Pick the ones that block villain's calling hands — for example,
  a missed nut flush draw blocks villain's flushes, making it less likely they can call.
  Draws that don't block anything useful go in your check-fold bucket.

- **Check-raising**: A balanced flop check-raise from BB mixes value and semi-bluffs.
  The overall frequency (~8-12% on the flop) is low, but without it villain c-bets
  with impunity.

## Opponent Profiling and Range Adjustments

Not everyone plays the same ranges. Adjust your estimates based on what you've observed.

**Tight player (nit)**: Opens ~10-12% from EP. 3-bet range is almost pure value (QQ+, AK).
Multiple streets of betting = believe them. You can fold more without losing much.
YOUR adjustment: bluff them more, value bet less thin.

**Loose-passive (calling station)**: Opens 30-40% from anywhere. Calls too much postflop —
bottom pair, gutshots, ace-high. Never bluff them. Value bet thinner (they'll pay).
YOUR adjustment: bet wider for value, cut bluffs entirely.

**Loose-aggressive (LAG)**: Opens wide, bets/raises aggressively. More bluffs in their
betting range than standard. Call them down lighter — but they also have strong hands
sometimes. YOUR adjustment: widen your calling range, trap more with strong hands.

**Tight-aggressive (TAG)**: Close to GTO. Hardest to read. Look for small tendencies —
always c-bet dry boards? Never check-raise the flop as a bluff? Exploit the edges.
YOUR adjustment: play close to GTO yourself, exploit the small leaks you find.

## Tools and Range Thinking Together

Range estimation and tools work as a cycle: think → estimate → verify → adjust.

**Step 1: Estimate villain's range** from position + actions.
"CO opened (~25%). I 3-bet from BB, he called. Calling range: TT-QQ, AQs, AJs, KQs —
about 50-60 combos."

**Step 2: Consider your own range** in villain's eyes.
"I 3-bet from BB — villain puts me on a polarized range. I could have AA/KK for value
or A5s/A4s as bluffs. My actual hand (KK) is squarely in my value range here."

**Step 3: Run equity** to quantify.
`equity.py Kh Kd "AQs,AJs,ATs,TT-QQ,77,22" As 7c 2d` — see exactly where you stand.

**Step 4: Use odds.py** to decide. Equity vs pot odds → profitable or not.

**Step 5: Construct your action range.** If you bet, what other hands in your range
also bet here? If you check, does that make your checking range too weak? Use the
balance principles from `gto-fundamentals.md` to calibrate.

## Common Mistakes

**Estimating villain's range but ignoring your own.** You figured out villain probably
has top pair. Great. But does villain know YOUR range is capped because you flatted
preflop? If so, villain might bet you off the pot even with medium strength.

**Using the same range estimate across multiple streets.** Ranges narrow. "20%" preflop
becomes maybe 10% by the turn and 5-8% by the river after a triple barrel. Update as
new actions come in.

**Ignoring position in range estimates.** A UTG open and a BTN open are completely
different ranges. A flop call from a UTG opener is much stronger than from a BTN opener.

**Not adjusting for the specific opponent.** GTO ranges are a baseline. The fish at your
table isn't playing GTO — use what you've actually observed.

**Forgetting about capped ranges.** Flat call preflop = no AA/KK. Check the flop =
probably not the nuts. These caps change the dynamic even if your specific hand is strong.

**Inconsistent stories.** You played passively for two streets then suddenly bomb the
river. What hand in your range would do this? If the answer is "only the nuts or only
a bluff," your range is too transparent.

**Mixing incorrectly.** If you always mix your medium hands but always commit with your
strong hands, you're not balanced — you're just being transparent at the top and
indecisive in the middle.

**Result-oriented range adjustments.** "He showed 72o last time, so his range is random."
One hand is noise. Adjust based on patterns over 20+ hands, not single observations.
