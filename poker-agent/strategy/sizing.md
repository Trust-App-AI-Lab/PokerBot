# Bet Sizing Theory

Why sizing matters: your bet size determines the bluff-to-value ratio needed
for balance, villain's pot odds, and how much you extract or deny equity.
The wrong size can turn a +EV bet into a -EV one.

## Fundamental Relationship: Size ↔ Balance

Your bet size dictates how much you can bluff to stay balanced. This isn't a rule you memorize — it follows directly from pot odds math. If you bet half pot, villain needs 25% equity to call profitably, which means 33% of your bets can be bluffs without villain gaining by calling. Use `odds.py` when you need exact numbers for a specific spot.

| Bet Size   | Villain's Pot Odds | Your Bluff Frequency |
|------------|-------------------|----------------------|
| 25% pot    | 17%               | ~20% of bets         |
| 33% pot    | 20%               | ~25% of bets         |
| 50% pot    | 25%               | ~33% of bets         |
| 66% pot    | 28%               | ~40% of bets         |
| 75% pot    | 30%               | ~43% of bets         |
| 100% pot   | 33%               | ~50% of bets         |
| 150% pot   | 38%               | ~60% of bets         |
| 200% pot   | 40%               | ~67% of bets         |

Larger bets → more bluffs allowed → more polarized range required.

## Preflop Sizing

### Open Raise (RFI)
- **Standard**: 2.5BB
- **BTN**: 2-2.5BB (can go smaller, you have position)
- **EP**: 2.5-3BB (want fewer callers, less multiway)
- **Per limper**: Add 1BB per limper
- **High rake games**: Raise larger to discourage marginal calls

### 3-Bet
- **In Position**: 3x the open (open 2.5BB → 3-bet to 7.5BB)
- **Out of Position**: 3.5-4x the open (open 2.5BB → 3-bet to 9-10BB)
- **Per cold caller**: Add ~1x the open per player who called between
- **Why bigger OOP?** Being OOP means less equity realization and harder decisions on every street (see `gto-fundamentals.md` Position section). A bigger 3-bet compensates by discouraging flat calls → more folds or 4-bets → cleaner decision tree when you can't act last

### 4-Bet
- **Standard**: 2.2-2.5x the 3-bet
- Example: 3-bet is 9BB → 4-bet to 20-22BB
- At 100BB effective, a 4-bet usually commits you to calling a 5-bet shove

### All-in Threshold
- If your raise would put in >33% of your stack → just go all-in
- The remaining stack has no fold equity left, so shoving is cleaner

## Postflop Sizing by Situation

### Small Bet (25-33% pot)

**Use when:**
- You have strong range advantage (A/K-high dry boards as PFR)
- Board is paired (villain rarely connects)
- You want to bet very frequently with most of your range
- You want to deny equity cheaply

**Effect:** Villain must defend very wide (MDF ~75%). Hard for villain to fold, but you're betting so often that your bluffs are cheap.

**Example:** You raised preflop, board is K-7-2 rainbow. Bet 33% with your entire range — AK, KQ (value), plus all your overcards and backdoor draws (bluffs). Villain has to call very wide.

### Medium Bet (50-66% pot)

**Use when:**
- Board has some draws but isn't super wet
- You have a clear value hand and want to charge draws
- Standard c-bet on most textures
- Turn and river bets in single-raised pots

**Effect:** Good balance between extraction and protection. Most common sizing.

### Large Bet (75-100% pot)

**Use when:**
- Board is very wet (flush draws + straight draws)
- Your range is polarized (strong value or bluffs)
- You want to charge maximum for draws
- River bets when ranges are polarized

**Effect:** Polarizing. Villain knows you're either strong or bluffing. MDF drops to 50-57%.

### Overbet (>100% pot)

**Use when:**
- You have nut advantage (villain can't have the best hands)
- River with polarized range and villain is capped
- Specific turn/river cards that dramatically change board dynamics
- You have the effective nuts and want maximum extraction

**Effect:** Very polarizing. Villain must fold a lot. Great for exploiting capped ranges.

**Example:** You 3-bet preflop with AA, board runs out 6-5-4-2-K all different suits. Villain called preflop and all streets. On the river K, you overbet — villain's calling range (76s, 65s, sets) didn't improve, but you still have an overpair+. Villain is capped at sets/straights and must fold many two-pair type hands.

## Sizing by Street

### Flop
- Most c-bets: 25-50% pot
- Wet boards: 50-66% pot
- Dry paired boards: 25-33% pot

### Turn
- Typically larger than flop (pot is bigger, ranges narrower)
- Continued value / double barrel: 55-75% pot
- Building pot for river shove: size so that a normal river bet will be all-in

### River
- Value bets: 60-100% pot (extract max from villain's calling range)
- Thin value: 33-50% pot (don't want to bet too big and only get called by better)
- Bluffs: Same sizing as your value bets! If you bet different sizes for value vs bluff, you're exploitable.
- Overbets: When you have nut advantage and villain is capped

## Raise Sizing (Post-flop)

### Flop Raise (check-raise or raise vs bet)
- **Standard**: 3x the bet
- Opponent bets 50 into 100 → raise to 150
- **On wet boards**: Can go larger (3.5x) to price out draws
- **As a bluff**: Same size as value (must be balanced)

### Turn/River Raise
- Usually large — 2.5-3x the bet
- Often this is close to an all-in at normal stack depths
- Turn raise is a very strong action — use only with top of range + some bluffs

## SPR-Based Committal Decisions

SPR (Stack-to-Pot Ratio) tells you how committed you already are to the pot — it's the ratio of your remaining stack to the current pot. A low SPR means you can't fold anymore because too much of your stack is already in. `odds.py` calculates this for you when you feed it the pot and bet amounts.

| SPR   | Commitment Level | Hand Needed |
|-------|-----------------|-------------|
| < 1   | Already committed | Any pair or better |
| 1-3   | Very committed | Top pair good kicker+ |
| 3-6   | Somewhat committed | Two pair+, strong draws |
| 6-10  | Not committed | Need strong hands to stack off |
| 10+   | Deep stacked | Sets+, very nutted hands |

**Practical rule**: If betting or calling would put you above 33% of your remaining stack → evaluate whether you're willing to go all-in. If not, consider a smaller action or folding.

## Common Sizing Mistakes

1. **Betting too small with value on wet boards** — you let draws call profitably
2. **Betting too big on dry boards** — you fold out everything except better hands
3. **Minbetting the river** — gives villain amazing odds, rarely accomplishes anything
4. **Different sizing for bluffs vs value** — screams "I'm bluffing" or "I have it"
5. **Not planning ahead** — your flop bet should set up turn and river sizes. Think in terms of "how much do I want in the pot by the river?"
