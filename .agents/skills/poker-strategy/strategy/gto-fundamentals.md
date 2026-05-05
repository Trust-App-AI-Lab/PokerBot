# GTO Fundamentals

What Game Theory Optimal means, why it matters, and how to think with it
at the table — not as a set of rules to memorize, but as a way of reasoning
about every decision.

## What GTO Actually Is

GTO is the strategy that cannot be exploited. If you play GTO perfectly, no
opponent can gain an edge over you regardless of how they adjust. You won't
crush a fish as hard as a perfect exploiter would, but you'll never be the
one getting crushed either.

In practice, nobody plays perfect GTO — not even solvers in every spot. What
matters is understanding the *thinking* behind it, so you can approximate it
as a baseline and know when and how to deviate.

The core idea: **every decision you make should be part of a strategy that
works even if your opponent knows exactly what you're doing.** If your strategy
breaks the moment someone figures you out, it's exploitable. If it holds up
no matter what — that's GTO.

## Balance: Why You Can't Just Play Your Hand

The most common beginner mistake is thinking about your specific hand in
isolation. "I have top pair, so I bet." "I missed, so I check." This is
exploitable because your actions become transparent — bet = strong, check = weak.

GTO thinking flips this: you don't ask "what should I do with THIS hand?"
You ask "what should my RANGE do in this spot, and where does this hand fit
within that range?"

When you bet the river, your betting range needs both value hands and bluffs.
Why? If you only bet with strong hands, a smart opponent just folds everything
except better. Your value bets stop making money. But if you mix in bluffs,
opponent has to call sometimes — which means your value bets get paid.

The right ratio of value to bluffs depends on your bet size, because your bet
size determines the pot odds you're offering:

| Bet Size (% pot) | Value % | Bluff % | Why |
|------------------|---------|---------|-----|
| 33% | ~71% | ~29% | Small bet → cheap bluffs, need fewer |
| 50% | ~67% | ~33% | Standard sizing |
| 75% | ~60% | ~40% | Bigger bet → more bluff room |
| 100% | ~50% | ~50% | Pot-sized → equal value and bluffs |
| 150% | ~43% | ~57% | Overbet → more bluffs than value |

This isn't a table to memorize — it's a consequence of pot odds math. The
bigger you bet, the worse odds you give villain, which means more of your bets
can be bluffs before villain can profitably call everything. `odds.py` can
calculate the exact numbers for any specific sizing.

The practical takeaway: **choose your bet size first, then check whether your
range has the right mix of value and bluffs for that size.** If you want to
bet big but only have value hands, your range is unbalanced. If you want to
bet small but have a polarized range (nuts or nothing), small sizing doesn't
exploit the situation. Sizing and range construction go hand in hand — see
`sizing.md` for how to match them.

## Defending: The Logic Behind MDF

When someone bets into you, you have to defend enough of your range to prevent
them from profiting with any two cards as a bluff. This minimum is called MDF
(Minimum Defense Frequency):

**MDF = 1 - [bet / (pot + bet)]**

| Facing Bet Size | MDF | What This Means |
|----------------|-----|-----------------|
| 33% pot | 75% | Must continue with 3/4 of your range |
| 50% pot | 67% | Must continue with 2/3 |
| 75% pot | 57% | Must continue with just over half |
| 100% pot | 50% | Must continue with half |
| 150% pot | 40% | Can fold more than half |

`odds.py` calculates MDF along with the EV of calling for any specific situation.

But here's the important part: **MDF is a thinking tool, not a commandment.**
It tells you what a balanced defense looks like against a balanced opponent.
If villain never bluffs the river, you should fold MORE than MDF — because
there are no bluffs to catch. If villain over-bluffs, you should call MORE
than MDF — because you profit from catching extra bluffs.

Think of MDF as the starting point: "against an unknown, I should defend roughly
this much." Then adjust based on what you know about this specific opponent.

## Polarization: How Ranges Evolve Through a Hand

A concept that connects everything else: as the hand progresses, betting ranges
naturally become more polarized — they split into strong hands and bluffs, with
the middle falling away.

Why does this happen? Think about what each street does:

**Flop**: Ranges are wide and merged. You might bet top pair, middle pair with
a backdoor draw, or even ace-high — all mixed together. The pot is small, so
medium hands can bet for thin value or as semi-bluffs without risking much.

**Turn**: The pot is bigger. Betting again means committing more money. Medium
hands start to worry — "if I bet and get raised, can I continue?" So medium
hands check for pot control, while strong hands and draws keep betting. The
range starts separating.

**River**: No more draws, no more potential. A bet is a pure statement: "I'm
either very strong or I'm bluffing." Medium hands gain nothing from betting —
worse folds, better calls. They belong in the checking range. This is full
polarization.

Understanding polarization changes how you think about every street:
- On the flop, don't be surprised when villain bets a wide range — they should.
- On the river, when villain bets, think in binary: "is this value or a bluff?"
  not "does villain have a medium hand?"
- When constructing your OWN betting range on later streets, make sure it's
  properly polarized — don't bet medium hands on the river just because you
  "feel like you're probably ahead."

For how polarization affects range estimation and construction in practice,
see `range.md`.

## Range Advantage and Nut Advantage

Two concepts that determine who "owns" a given board and therefore who should
be betting — and how big.

**Range advantage** asks: whose range is stronger *on average* on this board?

The preflop raiser usually has range advantage on high-card boards (A-K-7, K-Q-3)
because their opening range is weighted toward big cards. The caller has range
advantage on connected low boards (7-6-5, 8-7-4) because their flatting range
has more suited connectors and small pairs.

When you have range advantage, you can bet frequently with your entire range —
even weak hands — because on average your range is ahead. Your bluffs don't
need to work often because your value hands carry the whole strategy. Think
of it as "this board is mine, and a bet pressures villain's weak range."

**Nut advantage** asks: who can have the *absolute best* hands?

This is subtler. On A-K-7 the raiser has both range AND nut advantage (they
have AK, AA, KK). But on 7-6-5, the caller has nut advantage (they have 98,
43, 77, 66, 55) even though the raiser might still have overpairs.

Nut advantage determines sizing. If you can have the nuts and villain can't,
you can bet big — villain can never raise you, so your large bets are safe.
If villain has nut advantage, keep your bets small or check — you don't want
to build a pot where villain can blow you off your hand.

**Combining them in practice:**
- Range advantage + nut advantage → bet big, bet often
- Range advantage only → bet small, bet very often (1/3 pot with your whole range)
- Neither → check most of your range, let villain act first
- Nut advantage only → check some strong hands as traps, then check-raise

This framework tells you what to do BEFORE you look at your specific cards.
Board texture → who has advantage → what strategy makes sense → then check
where your hand fits within that strategy.

## Position: Why Acting Last Changes Everything

Position is arguably the single most important concept in poker — more important
than the cards you hold. A mediocre hand in position often outperforms a good
hand out of position. Understanding WHY tells you a lot about how poker works.

### Information Advantage

The player who acts last on every postflop street sees what their opponent does
before deciding. This sounds simple, but the consequences are enormous:

When villain checks to you, you learn something — they probably don't have a
very strong hand (or they're trapping, but that's a narrower scenario). You can
now bet confidently as a bluff or for thin value, because villain has revealed
weakness. When villain bets into you, you know the price and can make an informed
decision.

Out of position, you're always acting in the dark. You check and villain might
bet or check behind — you don't know which until after you've committed to
checking. You bet and villain might fold, call, or raise — each requiring a
different plan that you had to anticipate before acting. Every OOP decision is
a guess about what villain will do next. Every IP decision is a response to what
villain already did.

This is why the same hand plays so differently IP vs OOP. With JTs on a T-8-4
board, IP you can comfortably call a bet, bet when checked to, or raise — you
always have information. OOP with the same hand, you face painful decisions:
check and let villain check back for free equity? Bet and face a raise you
can't handle? There's no clean answer, because you're making decisions without
information.

### Equity Realization

A hand's raw equity (how often it wins at showdown) isn't the same as how much
money it actually makes. Equity realization is the gap between theoretical equity
and practical profit — and position is the biggest factor determining it.

IP, you realize MORE of your equity because:
- You can take free cards when you want them (villain checks, you check behind)
- You can value bet precisely (you see villain's action first, so you know when
  thin value is safe)
- You can bluff efficiently (villain's check tells you they're weak)
- You control the pot size (check back to keep it small, bet to grow it)

OOP, you realize LESS of your equity because:
- You can't take free cards reliably (if you check, villain might bet and you
  face a tough call)
- Bluffing is expensive (you bet without knowing if villain has air or a monster)
- You can't control pot size (villain decides whether to grow or shrink the pot)
- Your draws get priced out more often (villain bets when you want to see cheap
  cards)

This is why position affects range construction so directly. From BTN you open
~48% of hands, from UTG ~15%. The BTN range isn't wider just because fewer
players are left — it's wider because those hands MAKE MONEY in position that
they'd LOSE out of position. T7s from the button prints chips. T7s from UTG
against 5 opponents, mostly OOP? Losing play.

### How Position Shapes Strategy

Position doesn't just change which hands you play — it changes HOW you play
every hand:

**Betting and checking:** IP, you can safely check back weak hands for pot
control and bet strong hands for value. OOP, checking risks giving villain a
free card, but betting risks running into a stronger hand. This asymmetry is
why OOP strategies rely more on check-raising (trapping with the strong part
of your range when you can't bet for value cleanly).

**Pot control:** IP, you decide the final size of the pot on every street. If
you have a medium hand, you check back and keep it small. OOP, villain decides
— and they'll often make the pot bigger when you wish it was smaller.

**Bluffing:** IP bluffs are cheaper because you get clear signals (villain's
check = weakness). OOP bluffs are expensive because you're betting blind — you
might run into strength and waste money, or villain might have folded anyway.

**Multi-street planning:** IP, you can plan across streets flexibly — "if
villain checks turn, I'll bet. If they bet, I'll evaluate." OOP, your plan
has to account for multiple villain responses at every decision point, which
makes the game tree exponentially more complex.

This is why you'll see in `range.md` that position is the first filter in
range estimation — it determines how wide or narrow someone's starting range
is, which shapes every subsequent analysis. And in `sizing.md`, you'll notice
OOP bets are sized differently (3-bets are bigger OOP) precisely because the
positional disadvantage needs compensation through pot geometry.

## The Indifference Principle

At equilibrium, many hands are **indifferent** between two actions — the EV
of calling equals the EV of folding, or the EV of betting equals the EV of
checking. This is the engine behind mixed strategies.

When a hand is truly indifferent, it doesn't matter which action you choose
for YOUR EV. But the frequency you choose matters for BALANCE. If you always
fold your indifferent hands, you're folding too much and villain profits by
bluffing. If you always call, you're calling too much and villain profits by
value-betting thinner.

In practice: if a hand feels like a "close decision," it probably IS close —
both actions have similar EV. Don't agonize over "the right answer." Instead,
think about what your range needs: "am I folding too much in this spot overall?
Then I should lean toward calling with this marginal hand."

For how to actually implement mixed strategies at the table (randomization
methods, when to mix vs when to commit), see `range.md`.

## Exploitation: When to Break the Rules

GTO is the baseline. But poker isn't played against solvers — it's played
against humans with patterns and weaknesses. The strongest players combine
GTO understanding with exploitation: they know what balanced looks like, so
they can see where opponents deviate and profit from it.

The key question is always: **what is this opponent doing wrong, and how does
that change what's profitable?**

A villain who folds too much to c-bets is giving you free money — your bluffs
work more often than they should, so bluff more. A villain who never folds is
giving you different free money — your value bets get paid more often, so value
bet thinner and stop bluffing.

But exploitation has a cost: when you deviate from GTO to exploit one tendency,
you open yourself up to being counter-exploited. If you bluff every flop because
villain folds too much, and then villain adjusts and starts calling — you're
the one losing money.

**How to think about it:**
- Against unknowns, play close to GTO. You might not maximize against their
  specific leaks, but you won't make a big mistake either.
- Against players with clear patterns, deviate. The bigger and more consistent
  the pattern, the bigger your deviation can be.
- Always ask "what if opponent adjusts?" If your exploit still works even after
  they partially adjust, it's a good exploit. If it falls apart with any
  adjustment, it's fragile — proceed cautiously.
- One-off observations ("he bluffed that one time") aren't enough. Look for
  patterns across many hands before committing to an exploitative adjustment.

This connects directly to opponent profiling in `range.md` — the more accurately
you profile an opponent's range tendencies, the better your exploitative
adjustments become.
