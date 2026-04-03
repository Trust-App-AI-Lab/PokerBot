"""
Poker range parser and combo enumerator.

Parses standard range notation into concrete card combinations.
Supports: pairs (TT), suited (AKs), offsuit (AKo), wildcards (AK),
          ranges (TT+, 88-TT, A2s+), comma-separated lists.

CLI: python range_parser.py "QQ+, AKs, AQs+"
"""

import sys
from itertools import combinations

RANKS = "23456789TJQKA"
SUITS = "shdc"
RANK_IDX = {r: i for i, r in enumerate(RANKS)}


def _all_suits():
    """All 4 suits."""
    return list(range(4))


def _pair_combos(rank_ch: str, dead: set = None) -> list[tuple[str, str]]:
    """All 6 combos for a pocket pair, minus dead cards."""
    r = rank_ch
    combos = []
    for s1, s2 in combinations(range(4), 2):
        c1 = f"{r}{SUITS[s1]}"
        c2 = f"{r}{SUITS[s2]}"
        if dead and (c1 in dead or c2 in dead):
            continue
        combos.append((c1, c2))
    return combos


def _suited_combos(r1: str, r2: str, dead: set = None) -> list[tuple[str, str]]:
    """All 4 suited combos."""
    combos = []
    for s in range(4):
        c1 = f"{r1}{SUITS[s]}"
        c2 = f"{r2}{SUITS[s]}"
        if dead and (c1 in dead or c2 in dead):
            continue
        combos.append((c1, c2))
    return combos


def _offsuit_combos(r1: str, r2: str, dead: set = None) -> list[tuple[str, str]]:
    """All 12 offsuit combos."""
    combos = []
    for s1 in range(4):
        for s2 in range(4):
            if s1 == s2:
                continue
            c1 = f"{r1}{SUITS[s1]}"
            c2 = f"{r2}{SUITS[s2]}"
            if dead and (c1 in dead or c2 in dead):
                continue
            combos.append((c1, c2))
    return combos


def _expand_single(token: str, dead: set = None) -> list[tuple[str, str]]:
    """Expand a single range token into card combos."""
    token = token.strip()
    if not token:
        return []

    combos = []

    # Pair range: "88+" or "88-TT"
    if len(token) >= 3 and token[0] == token[1] and token[0] in RANK_IDX:
        base_rank = token[0]
        if token.endswith("+"):
            # e.g. "88+" → 88, 99, TT, JJ, QQ, KK, AA
            start = RANK_IDX[base_rank]
            for ri in range(start, 13):
                combos.extend(_pair_combos(RANKS[ri], dead))
        elif "-" in token:
            # e.g. "55-88"
            parts = token.split("-")
            start = RANK_IDX[parts[0][0]]
            end = RANK_IDX[parts[1][0]]
            lo, hi = min(start, end), max(start, end)
            for ri in range(lo, hi + 1):
                combos.extend(_pair_combos(RANKS[ri], dead))
        else:
            # Just "88"
            combos.extend(_pair_combos(base_rank, dead))
        return combos

    # Non-pair hands: "AKs", "AKo", "AK", "A2s+", "A2s-ATs"
    if len(token) >= 2 and token[0] in RANK_IDX and token[1] in RANK_IDX:
        r1, r2 = token[0], token[1]
        rest = token[2:]

        # Determine suited/offsuit/both
        if rest.startswith("s"):
            mode = "suited"
            rest = rest[1:]
        elif rest.startswith("o"):
            mode = "offsuit"
            rest = rest[1:]
        else:
            mode = "both"

        # Ensure r1 > r2 (higher rank first)
        if RANK_IDX[r1] < RANK_IDX[r2]:
            r1, r2 = r2, r1

        if rest == "+":
            # e.g. "A2s+" → A2s, A3s, A4s, ..., AKs (keeping high card, incrementing low)
            # e.g. "T8o+" → T8o, T9o
            start = RANK_IDX[r2]
            end = RANK_IDX[r1]  # exclusive — don't make it a pair
            for ri in range(start, end):
                if mode in ("suited", "both"):
                    combos.extend(_suited_combos(r1, RANKS[ri], dead))
                if mode in ("offsuit", "both"):
                    combos.extend(_offsuit_combos(r1, RANKS[ri], dead))
        elif "-" in rest:
            # e.g. "A2s-ATs"
            after_dash = rest.split("-")[1]
            # Parse the end hand
            end_r2 = after_dash[1] if len(after_dash) >= 2 else after_dash[0]
            start = RANK_IDX[r2]
            end = RANK_IDX[end_r2]
            lo, hi = min(start, end), max(start, end)
            for ri in range(lo, hi + 1):
                if mode in ("suited", "both"):
                    combos.extend(_suited_combos(r1, RANKS[ri], dead))
                if mode in ("offsuit", "both"):
                    combos.extend(_offsuit_combos(r1, RANKS[ri], dead))
        else:
            # Single hand: "AKs" or "AKo" or "AK"
            if mode in ("suited", "both"):
                combos.extend(_suited_combos(r1, r2, dead))
            if mode in ("offsuit", "both"):
                combos.extend(_offsuit_combos(r1, r2, dead))

        return combos

    raise ValueError(f"Cannot parse range token: '{token}'")


def parse_range(range_str: str, dead_cards: list[str] = None) -> list[tuple[str, str]]:
    """
    Parse a full range string into list of (card1, card2) tuples.

    Args:
        range_str: e.g. "QQ+, AKs, AJs+, 76s"
        dead_cards: cards already on board or in hero's hand (to exclude)

    Returns:
        List of (card1, card2) tuples representing all combos in the range.
    """
    dead = set(dead_cards) if dead_cards else None
    tokens = [t.strip() for t in range_str.split(",")]
    all_combos = []
    seen = set()

    for token in tokens:
        if not token:
            continue
        for combo in _expand_single(token, dead):
            key = tuple(sorted(combo))
            if key not in seen:
                seen.add(key)
                all_combos.append(combo)

    return all_combos


def count_combos(range_str: str, dead_cards: list[str] = None) -> int:
    """Count how many combos are in a range."""
    return len(parse_range(range_str, dead_cards))


# Preset ranges by percentage (approximate)
RANGE_PRESETS = {
    "5%":  "QQ+, AKs",
    "10%": "TT+, AQs+, AKo",
    "15%": "88+, ATs+, KQs, AJo+, KQo",
    "20%": "66+, A8s+, KTs+, QTs+, JTs, ATo+, KJo+, QJo",
    "25%": "55+, A5s+, K9s+, Q9s+, J9s+, T9s, ATo+, KTo+, QTo+, JTo",
    "30%": "44+, A2s+, K7s+, Q8s+, J8s+, T8s+, 98s, A9o+, KTo+, QTo+, JTo",
    "40%": "33+, A2s+, K4s+, Q6s+, J7s+, T7s+, 97s+, 87s, 76s, A7o+, K9o+, Q9o+, J9o+, T9o",
    "50%": "22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 96s+, 86s+, 75s+, 65s, 54s, A2o+, K7o+, Q8o+, J8o+, T8o+, 98o",
}


def get_preset_range(pct: str) -> str:
    """Get a preset range string by percentage."""
    if pct in RANGE_PRESETS:
        return RANGE_PRESETS[pct]
    raise ValueError(f"No preset for {pct}. Available: {list(RANGE_PRESETS.keys())}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python range_parser.py <range> [dead_cards...]")
        print('Example: python range_parser.py "QQ+, AKs" Ah Kd Tc')
        print(f"\nPreset ranges: {list(RANGE_PRESETS.keys())}")
        sys.exit(1)

    range_str = sys.argv[1]
    dead = sys.argv[2:] if len(sys.argv) > 2 else None

    # Check if it's a preset
    if range_str in RANGE_PRESETS:
        print(f"Preset {range_str} = {RANGE_PRESETS[range_str]}")
        range_str = RANGE_PRESETS[range_str]

    combos = parse_range(range_str, dead)
    print(f"Range: {range_str}")
    if dead:
        print(f"Dead cards: {dead}")
    print(f"Total combos: {len(combos)}")

    # Show first 20
    if len(combos) <= 20:
        for c in combos:
            print(f"  {c[0]} {c[1]}")
    else:
        for c in combos[:10]:
            print(f"  {c[0]} {c[1]}")
        print(f"  ... ({len(combos) - 20} more)")
        for c in combos[-10:]:
            print(f"  {c[0]} {c[1]}")
