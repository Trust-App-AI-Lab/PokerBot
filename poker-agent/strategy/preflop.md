# Preflop Strategy

Decision trees for every preflop scenario in 6-max cash games.
All frequency data comes from `tools/preflop.py` — this doc covers *when* and *why*.

## Scenario 1: Open Raise (First In / RFI)

No one has entered the pot yet. You are first to act or everyone before you folded.

**Tool**: `preflop.py <card1> <card2> <position>` → raise frequency

**Principles:**
- Open or fold. Never limp (except possibly SB in some GTO solutions).
- Ranges widen as position improves: UTG ~15%, HJ ~19%, CO ~27%, BTN ~48%, SB ~40%.
- SB is tighter than BTN despite being later — because SB is OOP postflop vs BB.
- Mixed frequency hands: use the frequency. Don't always raise or always fold.

**Standard sizing:** 2.5BB. Some players use 2BB from BTN, 3BB from EP.
Add 1BB per limper if anyone limped (though GTO doesn't have limpers).

**Why A5s opens from UTG but A8o doesn't:**
- A5s has nut flush potential, wheel straight potential, and blocks AA/A5.
- A8o has none of that. It's dominated by AK/AQ/AJ and makes weak top pairs.
- Suitedness adds ~3-4% equity and much more playability postflop.

## Scenario 2: Facing an Open Raise

Someone raised before you. Your options: 3-bet, call, or fold.

### 3-Bet Range Construction
A GTO 3-bet range has two components:
1. **Value 3-bets**: Hands strong enough to build a big pot for value.
2. **Bluff 3-bets**: Hands that benefit from fold equity and play well if called.

**Value**: QQ+, AKs (always). JJ, TT, AQs (mixed frequency, position-dependent).
**Bluffs**: A5s, A4s, A3s (blocks AA, nut flush draw). Some suited connectors at low frequency.

**Why A5s is a better 3-bet bluff than KJo:**
- A5s blocks AA and AKs (reduces villain's continue range)
- If called, has nut flush draw and wheel potential
- KJo blocks nothing important, dominated by villain's calling range, bad OOP

### 3-Bet frequency by matchup (approximate):
| My Position | vs UTG  | vs HJ  | vs CO  | vs BTN |
|-------------|---------|--------|--------|--------|
| HJ          | ~6%     | —      | —      | —      |
| CO          | ~7%     | ~8%    | —      | —      |
| BTN         | ~8%     | ~10%   | ~12%   | —      |
| SB          | ~10%    | ~11%   | ~13%   | ~15%   |
| BB          | ~9%     | ~10%   | ~12%   | ~14%   |

### Calling (Flatting) Range
Hands good enough to play but not to 3-bet. **Prefer to flat in position only.**

- **IP flat**: Mid pairs (77-TT), suited broadways (KJs, QJs, JTs), suited connectors (98s, 87s, 76s)
- **OOP flat**: Very rarely in GTO. BB defends wider because of pot odds (already posted 1BB).
- **SB**: Almost never flat — 3-bet or fold. Flatting SB is one of the biggest leaks in low stakes.

## Scenario 3: Facing a 3-Bet

You opened, someone 3-bet. Options: 4-bet, call, or fold.

**4-Bet value**: AA, KK (always). QQ, AKs (mostly, some mixed).
**4-Bet bluff**: A5s (blocks AA), occasional A4s/A3s. Low frequency.
**Call**: QQ (sometimes), JJ, TT (in position), AKo, AQs, some suited connectors if deep.
**Fold**: Most of your opening range. This is normal — 3-bet pots are expensive.

**Sizing**: 2.2-2.5x the 3-bet. Example: villain 3-bets to 9BB → you 4-bet to 20-22BB.

## Scenario 4: Facing a 4-Bet

4-bet pots are committing. Effective SPR will be ~1-2 after the flop.

**5-bet all-in**: AA, KK (always). QQ, AKs (against wide 4-bettors).
**Call**: AKs, QQ sometimes. This is very rare in GTO — most hands either shove or fold.
**Fold**: Almost everything. If you 4-bet bluffed and got 5-bet, fold.

## Scenario 5: BB Defense vs Open Raise

BB has special rules because you already posted 1BB → better pot odds.

**vs 2.5BB open, you need to call 1.5BB to win 4BB → 27% pot odds.**
This means you can defend very wide — GTO defends ~55-65% of hands from BB vs BTN open.

BB defense mix:
- **3-bet** (~12-15% vs BTN): Value + bluffs as above
- **Call** (~40-50% vs BTN): Very wide. Almost any suited hand, any pair, most broadways.
- **Fold** (~35-45% vs BTN): Only true junk (unsuited disconnected low cards)

**vs EP open**: Defend much tighter. ~30-35% total defense vs UTG.

## Scenario 6: SB vs BB (Heads Up Blind Battle)

When folded to SB, it's essentially a heads-up pot. SB opens very wide (~40%).

**SB strategy**: Raise or fold. Never limp in a GTO framework.
(Some solvers do find a small limping range from SB, but raise-or-fold is simpler
and nearly as good.)

**BB vs SB open**: Defend very wide (~60-70%).
- 3-bet ~15-18% (wider than vs other positions, because SB's range is wide)
- Call ~45-50%
- Fold only the worst hands

## Multi-way Pots

When multiple players are already in the pot:

- **Tighten your range significantly.** You need a stronger hand to play vs 3 opponents than vs 1.
- **Draws gain value** (implied odds from multiple players)
- **Bluff 3-bets lose value** (less fold equity with callers behind)
- **Don't squeeze light** with players yet to act behind you

## Key Preflop Heuristics

1. **Position > cards.** A mediocre hand in position is often better than a good hand OOP.
2. **Suited > offsuit.** Not just for flush — suitedness gives playability, nut potential, and combo draw possibilities.
3. **Connectedness matters.** 87s > K3s even though K3s has a higher card. Connectivity = straight potential = postflop equity.
4. **Respect 3-bets from EP.** UTG open → HJ 3-bet usually means QQ+ or AK. Don't call with JTs here.
5. **Don't be afraid to fold preflop.** Folding a marginal hand preflop costs 0. Calling and losing a big pot costs a lot.
