"""
GTO Pre-flop hand analysis for 6-max cash games (100BB).

Position-aware opening ranges with mixed strategy frequencies.
Based on solver-derived GTO charts for online 6-max NL Hold'em.

Card format: "{rank}{suit}" e.g. "Ah", "Ts", "2c"

CLI:
  python preflop.py <card1> <card2> [position]
  python preflop.py Ah Ks BTN
  python preflop.py 7h 6h CO
  python preflop.py Jc Jd          # shows all positions
"""

import sys
import random

RANK_ORDER = "23456789TJQKA"
RANK_IDX = {r: i for i, r in enumerate(RANK_ORDER)}

# ============================================================
# GTO Open-Raise Ranges (RFI) by Position — 6-max, 100BB
# ============================================================
# Format: hand_notation → raise frequency (0.0 to 1.0)
#   1.0 = always raise, 0.5 = raise 50% / fold 50%, 0.0 = always fold
#
# These are "first in" ranges (no one has raised before you).
# Derived from solver outputs for 6-max 100BB deep cash games.
# ============================================================

# UTG (Under The Gun) — ~15% of hands
GTO_RFI_UTG = {
    # Premium pairs: always raise
    "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0, "TT": 1.0,
    # Mid pairs: always or high freq
    "99": 1.0, "88": 1.0, "77": 1.0,
    # Small pairs: mixed
    "66": 0.8, "55": 0.5, "44": 0.3, "33": 0.2, "22": 0.2,
    # Suited broadways
    "AKs": 1.0, "AQs": 1.0, "AJs": 1.0, "ATs": 1.0,
    "KQs": 1.0, "KJs": 1.0, "KTs": 0.8,
    "QJs": 1.0, "QTs": 0.7,
    "JTs": 1.0,
    # Suited aces (blockers + nut flush draws)
    "A9s": 0.5, "A8s": 0.3, "A7s": 0.2, "A6s": 0.2, "A5s": 0.7, "A4s": 0.5, "A3s": 0.3, "A2s": 0.2,
    # Suited connectors
    "T9s": 0.8, "98s": 0.5, "87s": 0.3, "76s": 0.2,
    # Offsuit broadways
    "AKo": 1.0, "AQo": 1.0, "AJo": 0.8, "ATo": 0.3,
    "KQo": 0.7, "KJo": 0.2,
}

# HJ (Hijack) — ~19% of hands
GTO_RFI_HJ = {
    "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0, "TT": 1.0,
    "99": 1.0, "88": 1.0, "77": 1.0,
    "66": 1.0, "55": 0.8, "44": 0.6, "33": 0.5, "22": 0.5,
    "AKs": 1.0, "AQs": 1.0, "AJs": 1.0, "ATs": 1.0, "A9s": 0.8,
    "A8s": 0.6, "A7s": 0.5, "A6s": 0.4, "A5s": 0.9, "A4s": 0.7, "A3s": 0.5, "A2s": 0.4,
    "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "K9s": 0.6,
    "QJs": 1.0, "QTs": 1.0, "Q9s": 0.5,
    "JTs": 1.0, "J9s": 0.7,
    "T9s": 1.0, "T8s": 0.4,
    "98s": 0.8, "87s": 0.6, "76s": 0.5, "65s": 0.4, "54s": 0.3,
    "AKo": 1.0, "AQo": 1.0, "AJo": 1.0, "ATo": 0.7,
    "KQo": 1.0, "KJo": 0.6, "KTo": 0.2,
    "QJo": 0.5, "JTo": 0.2,
}

# CO (Cutoff) — ~27% of hands
GTO_RFI_CO = {
    "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0, "TT": 1.0,
    "99": 1.0, "88": 1.0, "77": 1.0,
    "66": 1.0, "55": 1.0, "44": 1.0, "33": 0.8, "22": 0.8,
    "AKs": 1.0, "AQs": 1.0, "AJs": 1.0, "ATs": 1.0, "A9s": 1.0,
    "A8s": 1.0, "A7s": 0.8, "A6s": 0.7, "A5s": 1.0, "A4s": 1.0, "A3s": 0.8, "A2s": 0.7,
    "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "K9s": 0.9, "K8s": 0.5, "K7s": 0.4,
    "QJs": 1.0, "QTs": 1.0, "Q9s": 0.9, "Q8s": 0.5,
    "JTs": 1.0, "J9s": 1.0, "J8s": 0.5,
    "T9s": 1.0, "T8s": 0.8,
    "98s": 1.0, "97s": 0.6, "87s": 1.0, "86s": 0.5,
    "76s": 1.0, "75s": 0.4, "65s": 0.8, "64s": 0.3, "54s": 0.7, "43s": 0.2,
    "AKo": 1.0, "AQo": 1.0, "AJo": 1.0, "ATo": 1.0, "A9o": 0.7,
    "KQo": 1.0, "KJo": 1.0, "KTo": 0.7,
    "QJo": 1.0, "QTo": 0.5,
    "JTo": 0.7, "J9o": 0.2,
    "T9o": 0.3,
}

# BTN (Button) — ~48% of hands
GTO_RFI_BTN = {
    "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0, "TT": 1.0,
    "99": 1.0, "88": 1.0, "77": 1.0,
    "66": 1.0, "55": 1.0, "44": 1.0, "33": 1.0, "22": 1.0,
    "AKs": 1.0, "AQs": 1.0, "AJs": 1.0, "ATs": 1.0, "A9s": 1.0,
    "A8s": 1.0, "A7s": 1.0, "A6s": 1.0, "A5s": 1.0, "A4s": 1.0, "A3s": 1.0, "A2s": 1.0,
    "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "K9s": 1.0, "K8s": 1.0, "K7s": 1.0,
    "K6s": 0.8, "K5s": 0.8, "K4s": 0.7, "K3s": 0.6, "K2s": 0.5,
    "QJs": 1.0, "QTs": 1.0, "Q9s": 1.0, "Q8s": 1.0, "Q7s": 0.6, "Q6s": 0.5, "Q5s": 0.4,
    "JTs": 1.0, "J9s": 1.0, "J8s": 1.0, "J7s": 0.6, "J6s": 0.4,
    "T9s": 1.0, "T8s": 1.0, "T7s": 0.7, "T6s": 0.4,
    "98s": 1.0, "97s": 1.0, "96s": 0.6,
    "87s": 1.0, "86s": 0.9, "85s": 0.5,
    "76s": 1.0, "75s": 0.8, "74s": 0.3,
    "65s": 1.0, "64s": 0.7, "63s": 0.2,
    "54s": 1.0, "53s": 0.6, "43s": 0.5, "32s": 0.2,
    "AKo": 1.0, "AQo": 1.0, "AJo": 1.0, "ATo": 1.0, "A9o": 1.0,
    "A8o": 0.9, "A7o": 0.8, "A6o": 0.6, "A5o": 0.7, "A4o": 0.6, "A3o": 0.5, "A2o": 0.4,
    "KQo": 1.0, "KJo": 1.0, "KTo": 1.0, "K9o": 0.8, "K8o": 0.5, "K7o": 0.3,
    "QJo": 1.0, "QTo": 1.0, "Q9o": 0.7, "Q8o": 0.3,
    "JTo": 1.0, "J9o": 0.8, "J8o": 0.3,
    "T9o": 0.9, "T8o": 0.5,
    "98o": 0.7, "97o": 0.2,
    "87o": 0.5, "76o": 0.3,
}

# SB (Small Blind) — open-raise or fold (no limping in GTO)
# ~40% raise, rest fold. SB plays tighter than BTN because OOP postflop.
GTO_RFI_SB = {
    "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0, "TT": 1.0,
    "99": 1.0, "88": 1.0, "77": 1.0,
    "66": 1.0, "55": 1.0, "44": 0.9, "33": 0.8, "22": 0.7,
    "AKs": 1.0, "AQs": 1.0, "AJs": 1.0, "ATs": 1.0, "A9s": 1.0,
    "A8s": 1.0, "A7s": 0.9, "A6s": 0.8, "A5s": 1.0, "A4s": 0.9, "A3s": 0.8, "A2s": 0.7,
    "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "K9s": 1.0, "K8s": 0.7, "K7s": 0.6,
    "K6s": 0.5, "K5s": 0.5, "K4s": 0.4, "K3s": 0.3, "K2s": 0.3,
    "QJs": 1.0, "QTs": 1.0, "Q9s": 0.9, "Q8s": 0.6, "Q7s": 0.3,
    "JTs": 1.0, "J9s": 1.0, "J8s": 0.6, "J7s": 0.3,
    "T9s": 1.0, "T8s": 0.9, "T7s": 0.4,
    "98s": 1.0, "97s": 0.7, "96s": 0.3,
    "87s": 1.0, "86s": 0.6, "85s": 0.2,
    "76s": 0.9, "75s": 0.5,
    "65s": 0.8, "64s": 0.4,
    "54s": 0.8, "53s": 0.3, "43s": 0.3,
    "AKo": 1.0, "AQo": 1.0, "AJo": 1.0, "ATo": 1.0, "A9o": 0.9,
    "A8o": 0.7, "A7o": 0.5, "A6o": 0.4, "A5o": 0.5, "A4o": 0.4, "A3o": 0.3, "A2o": 0.3,
    "KQo": 1.0, "KJo": 1.0, "KTo": 0.8, "K9o": 0.5, "K8o": 0.2,
    "QJo": 0.9, "QTo": 0.6, "Q9o": 0.3,
    "JTo": 0.7, "J9o": 0.3,
    "T9o": 0.5, "T8o": 0.2,
    "98o": 0.3,
    "87o": 0.2,
}

# ============================================================
# 3-Bet Ranges (vs open-raise) by position matchup
# ============================================================
# Format: same as above, frequency = 3-bet frequency (rest = call or fold)
# Simplified: only most common matchups
# ============================================================

# BB vs BTN open (very wide 3-bet range since BTN opens wide)
GTO_3BET_BB_vs_BTN = {
    "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.9,
    "TT": 0.5, "99": 0.3, "88": 0.2, "77": 0.15,
    "66": 0.1, "55": 0.1,
    "AKs": 1.0, "AQs": 0.8, "AJs": 0.5, "ATs": 0.4,
    "A9s": 0.3, "A8s": 0.2, "A7s": 0.2, "A6s": 0.25, "A5s": 0.5, "A4s": 0.4, "A3s": 0.3, "A2s": 0.25,
    "KQs": 0.6, "KJs": 0.4, "KTs": 0.3, "K9s": 0.2,
    "QJs": 0.3, "QTs": 0.2,
    "JTs": 0.2, "J9s": 0.1,
    "T9s": 0.15,
    "AKo": 1.0, "AQo": 0.6, "AJo": 0.35, "ATo": 0.25,
    "KQo": 0.35, "KJo": 0.2,
    "QJo": 0.1,
}

# BB vs CO open
GTO_3BET_BB_vs_CO = {
    "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.85,
    "TT": 0.4, "99": 0.2, "88": 0.1,
    "AKs": 1.0, "AQs": 0.75, "AJs": 0.4, "ATs": 0.3,
    "A5s": 0.45, "A4s": 0.35, "A3s": 0.2,
    "KQs": 0.55, "KJs": 0.3, "KTs": 0.2,
    "QJs": 0.2,
    "AKo": 1.0, "AQo": 0.55, "AJo": 0.3,
    "KQo": 0.25,
}

# BB vs UTG open (tighter 3-bet range)
GTO_3BET_BB_vs_UTG = {
    "AA": 1.0, "KK": 1.0, "QQ": 0.9, "JJ": 0.5,
    "TT": 0.2,
    "AKs": 1.0, "AQs": 0.5, "AJs": 0.2,
    "A5s": 0.3, "A4s": 0.2,
    "KQs": 0.3,
    "AKo": 1.0, "AQo": 0.3,
}

# SB vs BTN open (SB usually 3-bets or folds, rarely calls)
GTO_3BET_SB_vs_BTN = {
    "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0,
    "TT": 0.8, "99": 0.6, "88": 0.4, "77": 0.3,
    "66": 0.2, "55": 0.2,
    "AKs": 1.0, "AQs": 1.0, "AJs": 0.8, "ATs": 0.6,
    "A9s": 0.4, "A8s": 0.3, "A7s": 0.3, "A6s": 0.3, "A5s": 0.7, "A4s": 0.5, "A3s": 0.4, "A2s": 0.3,
    "KQs": 1.0, "KJs": 0.7, "KTs": 0.5, "K9s": 0.3,
    "QJs": 0.6, "QTs": 0.4,
    "JTs": 0.5, "J9s": 0.2,
    "T9s": 0.3,
    "98s": 0.2,
    "AKo": 1.0, "AQo": 0.9, "AJo": 0.6, "ATo": 0.4,
    "KQo": 0.6, "KJo": 0.3, "KTo": 0.2,
    "QJo": 0.2,
}

# All RFI charts indexed by position
RFI_CHARTS = {
    "UTG": GTO_RFI_UTG,
    "HJ":  GTO_RFI_HJ,
    "CO":  GTO_RFI_CO,
    "BTN": GTO_RFI_BTN,
    "SB":  GTO_RFI_SB,
}

# 3-bet charts indexed by (defender_pos, raiser_pos)
THREE_BET_CHARTS = {
    ("BB", "BTN"):  GTO_3BET_BB_vs_BTN,
    ("BB", "CO"):   GTO_3BET_BB_vs_CO,
    ("BB", "UTG"):  GTO_3BET_BB_vs_UTG,
    ("BB", "HJ"):   GTO_3BET_BB_vs_UTG,  # Similar to vs UTG
    ("SB", "BTN"):  GTO_3BET_SB_vs_BTN,
    ("SB", "CO"):   GTO_3BET_BB_vs_CO,   # Approximation
}

POSITIONS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"]


def hand_notation(card1: str, card2: str) -> str:
    """Convert two cards to standard notation like 'AKs' or 'TTo'."""
    r1_ch = card1[0].upper()
    r2_ch = card2[0].upper()
    s1 = card1[1].lower()
    s2 = card2[1].lower()

    r1_idx = RANK_IDX[r1_ch]
    r2_idx = RANK_IDX[r2_ch]

    if r1_idx >= r2_idx:
        hi, lo = r1_ch, r2_ch
    else:
        hi, lo = r2_ch, r1_ch

    if r1_ch == r2_ch:
        return f"{hi}{lo}"
    elif s1 == s2:
        return f"{hi}{lo}s"
    else:
        return f"{hi}{lo}o"


def rfi_advice(card1: str, card2: str, position: str) -> dict:
    """
    GTO open-raise (RFI) advice for a given hand and position.

    Returns:
        dict with hand, position, action, frequency, and note
    """
    position = position.upper()
    notation = hand_notation(card1, card2)

    if position == "BB":
        return {
            "hand": notation,
            "position": position,
            "action": "check",
            "frequency": 1.0,
            "note": "BB closes action preflop (if no raise). See 3-bet chart if facing a raise.",
        }

    chart = RFI_CHARTS.get(position)
    if not chart:
        return {"error": f"Unknown position: {position}. Use: {POSITIONS}"}

    freq = chart.get(notation, 0.0)

    if freq >= 0.95:
        action = "RAISE"
        note = "Always open-raise."
    elif freq >= 0.7:
        action = "RAISE"
        note = f"Strong open — raise ~{freq:.0%} of the time."
    elif freq >= 0.4:
        action = "MIXED"
        note = f"Mixed strategy — raise ~{freq:.0%}, fold ~{1-freq:.0%}."
    elif freq > 0:
        action = "MIXED (lean fold)"
        note = f"Marginal — raise only ~{freq:.0%}, usually fold."
    else:
        action = "FOLD"
        note = "Not in opening range for this position."

    return {
        "hand": notation,
        "position": position,
        "action": action,
        "raise_freq": freq,
        "fold_freq": round(1 - freq, 2),
        "note": note,
    }


def three_bet_advice(card1: str, card2: str, my_pos: str, raiser_pos: str) -> dict:
    """
    GTO 3-bet advice when facing an open-raise.

    Args:
        card1, card2: Your hole cards
        my_pos: Your position (typically BB or SB)
        raiser_pos: Position of the open-raiser

    Returns:
        dict with action frequencies
    """
    my_pos = my_pos.upper()
    raiser_pos = raiser_pos.upper()
    notation = hand_notation(card1, card2)

    key = (my_pos, raiser_pos)
    chart = THREE_BET_CHARTS.get(key)

    if not chart:
        return {
            "hand": notation,
            "my_pos": my_pos,
            "vs": raiser_pos,
            "note": f"No specific 3-bet chart for {my_pos} vs {raiser_pos}. Use general principles.",
            "general_advice": "3-bet premium hands (QQ+, AKs) for value. Mix in bluffs with A5s-A2s type hands.",
        }

    freq_3bet = chart.get(notation, 0.0)

    # Estimate call frequency (hands in raiser's range that aren't 3-bet are sometimes called)
    raiser_chart = RFI_CHARTS.get(raiser_pos, {})
    raiser_has_hand = raiser_chart.get(notation, 0) > 0

    if freq_3bet >= 0.9:
        action = "3-BET"
        note = "Always 3-bet for value."
    elif freq_3bet >= 0.5:
        action = "3-BET"
        note = f"3-bet ~{freq_3bet:.0%}. Can also call/fold the rest."
    elif freq_3bet >= 0.2:
        action = "MIXED"
        note = f"Mixed: 3-bet ~{freq_3bet:.0%}, call or fold the rest."
    elif freq_3bet > 0:
        action = "MIXED (lean call/fold)"
        note = f"Mostly call or fold. 3-bet only ~{freq_3bet:.0%} as a bluff mix."
    else:
        action = "CALL or FOLD"
        note = "Not a 3-bet candidate. Call if pot odds justify, else fold."

    return {
        "hand": notation,
        "my_pos": my_pos,
        "vs": raiser_pos,
        "action": action,
        "three_bet_freq": freq_3bet,
        "note": note,
    }


def should_raise(card1: str, card2: str, position: str) -> bool:
    """
    Randomized GTO decision: should we raise?
    Uses the frequency as probability.
    """
    position = position.upper()
    notation = hand_notation(card1, card2)
    chart = RFI_CHARTS.get(position, {})
    freq = chart.get(notation, 0.0)
    return random.random() < freq


def analyze(card1: str, card2: str, position: str = None) -> dict:
    """
    Full pre-flop analysis. If position given, returns position-specific advice.
    If no position, returns advice for ALL positions.
    """
    notation = hand_notation(card1, card2)

    if position:
        rfi = rfi_advice(card1, card2, position)
        return {
            "hand": notation,
            "position": position,
            **rfi,
        }

    # All positions
    result = {"hand": notation, "positions": {}}
    for pos in ["UTG", "HJ", "CO", "BTN", "SB"]:
        chart = RFI_CHARTS[pos]
        freq = chart.get(notation, 0.0)
        if freq >= 0.95:
            tag = "RAISE"
        elif freq > 0:
            tag = f"RAISE {freq:.0%}"
        else:
            tag = "FOLD"
        result["positions"][pos] = {"action": tag, "raise_freq": freq}

    return result


def _format_position_line(pos: str, data: dict) -> str:
    """Format a single position line for display."""
    freq = data["raise_freq"]
    action = data["action"]
    bar_len = int(freq * 20)
    bar = "█" * bar_len + "░" * (20 - bar_len)
    return f"  {pos:>3}  {bar}  {action}"


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python preflop.py <card1> <card2> [position]")
        print("  python preflop.py Ah Ks BTN     # specific position")
        print("  python preflop.py 7h 6h          # all positions")
        print(f"  Positions: {POSITIONS}")
        sys.exit(1)

    c1, c2 = sys.argv[1], sys.argv[2]
    pos = sys.argv[3] if len(sys.argv) > 3 else None

    notation = hand_notation(c1, c2)

    if pos:
        result = rfi_advice(c1, c2, pos)
        print(f"Hand:      {result['hand']}")
        print(f"Position:  {result['position']}")
        print(f"Action:    {result['action']}")
        if 'raise_freq' in result:
            print(f"Raise:     {result['raise_freq']:.0%}")
            print(f"Fold:      {result['fold_freq']:.0%}")
        print(f"Note:      {result['note']}")
    else:
        result = analyze(c1, c2)
        print(f"Hand: {result['hand']}")
        print(f"{'─' * 42}")
        for p in ["UTG", "HJ", "CO", "BTN", "SB"]:
            data = result["positions"][p]
            print(_format_position_line(p, data))
        print(f"{'─' * 42}")
        print("█ = raise frequency   ░ = fold frequency")
