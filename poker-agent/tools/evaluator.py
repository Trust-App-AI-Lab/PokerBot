from __future__ import annotations
"""
Poker hand evaluator — fast direct evaluation (no combinations iteration).
For 7-card hands, determines best hand directly from rank/suit analysis.

Card format: "{rank}{suit}" e.g. "Ah", "Ts", "2c"
Card tuple: (rank_index, suit_index) where rank 0=2..12=A, suit 0=s,1=h,2=d,3=c
"""

RANKS = "23456789TJQKA"
RANK_MAP = {r: i for i, r in enumerate(RANKS)}
SUIT_MAP = {'s': 0, 'h': 1, 'd': 2, 'c': 3}

HAND_CLASSES = [
    "High Card", "One Pair", "Two Pair", "Three of a Kind",
    "Straight", "Flush", "Full House", "Four of a Kind",
    "Straight Flush", "Royal Flush",
]


def parse_card(card_str: str) -> tuple[int, int]:
    return (RANK_MAP[card_str[0].upper()], SUIT_MAP[card_str[1].lower()])

def card_to_str(rank: int, suit: int) -> str:
    return RANKS[rank] + "shdc"[suit]

def card_to_int(card_str: str) -> int:
    return RANK_MAP[card_str[0].upper()] * 4 + SUIT_MAP[card_str[1].lower()]

def int_to_tuple(i: int) -> tuple[int, int]:
    return (i >> 2, i & 3)

def full_deck() -> list[tuple[int, int]]:
    return [(r, s) for r in range(13) for s in range(4)]


def _find_straight(rank_bits: int) -> int:
    """Find highest straight in rank bitmask. Returns high card rank or -1."""
    for high in range(12, 3, -1):  # A-high down to 6-high
        mask = 0b11111 << (high - 4)
        if (rank_bits & mask) == mask:
            return high
    # Wheel: A-2-3-4-5
    if (rank_bits & 0b1000000001111) == 0b1000000001111:
        return 3  # 5-high
    return -1


def evaluate(cards: list[tuple[int, int]]) -> tuple:
    """
    Evaluate best 5-card hand from 5-7 cards directly.
    Returns comparable tuple (higher = better).
    """
    n = len(cards)
    if n < 5:
        raise ValueError("Need >= 5 cards")

    # Count rank frequencies and track suits
    rc = [0] * 13  # rank counts
    sc = [0] * 4   # suit counts
    suit_cards = [[] for _ in range(4)]  # cards per suit

    for r, s in cards:
        rc[r] += 1
        sc[s] += 1
        suit_cards[s].append(r)

    # Check flush (5+ of one suit)
    flush_suit = -1
    for s in range(4):
        if sc[s] >= 5:
            flush_suit = s
            break

    # Check straight flush first (highest hand)
    if flush_suit >= 0:
        flush_ranks = suit_cards[flush_suit]
        flush_bits = 0
        for r in flush_ranks:
            flush_bits |= (1 << r)
        sf_high = _find_straight(flush_bits)
        if sf_high >= 0:
            if sf_high == 12:
                return (9, 12)  # Royal Flush
            return (8, sf_high)  # Straight Flush

    # Classify by rank frequencies
    quads = []
    trips = []
    pairs = []
    singles = []
    for r in range(12, -1, -1):  # high to low
        c = rc[r]
        if c == 4:
            quads.append(r)
        elif c == 3:
            trips.append(r)
        elif c == 2:
            pairs.append(r)
        elif c == 1:
            singles.append(r)

    # Four of a kind
    if quads:
        # Best kicker from remaining cards
        kicker = -1
        for r in range(12, -1, -1):
            if r != quads[0] and rc[r] > 0:
                kicker = r
                break
        return (7, quads[0], kicker)

    # Full house (trip + pair, or trip + trip)
    if len(trips) >= 2:
        return (6, trips[0], trips[1])
    if trips and pairs:
        return (6, trips[0], pairs[0])

    # Flush (no straight flush, already checked)
    if flush_suit >= 0:
        top5 = sorted(suit_cards[flush_suit], reverse=True)[:5]
        return (5,) + tuple(top5)

    # Straight
    all_bits = 0
    for r in range(13):
        if rc[r] > 0:
            all_bits |= (1 << r)
    st_high = _find_straight(all_bits)
    if st_high >= 0:
        return (4, st_high)

    # Three of a kind
    if trips:
        kickers = (singles + pairs)[:2]  # best 2 kickers (pairs count as singles here)
        # Actually, collect all non-trip ranks sorted
        kickers = sorted([r for r in range(12, -1, -1) if rc[r] > 0 and r != trips[0]], reverse=True)[:2]
        return (3, trips[0]) + tuple(kickers)

    # Two pair
    if len(pairs) >= 2:
        # With 7 cards can have 3 pairs; pick best 2
        top2 = pairs[:2]  # already sorted high to low
        kicker = -1
        for r in range(12, -1, -1):
            if r not in top2 and rc[r] > 0:
                kicker = r
                break
        return (2, top2[0], top2[1], kicker)

    # One pair
    if pairs:
        kickers = sorted([r for r in range(12, -1, -1) if rc[r] > 0 and r != pairs[0]], reverse=True)[:3]
        return (1, pairs[0]) + tuple(kickers)

    # High card: best 5
    top5 = sorted([r for r in range(13) if rc[r] > 0], reverse=True)[:5]
    return (0,) + tuple(top5)


def evaluate_hand(card_strings: list[str]) -> tuple:
    cards = [parse_card(c) for c in card_strings]
    result = evaluate(cards)
    return (result[0], result[1:], HAND_CLASSES[result[0]])


def compare_hands(hand_a: list[str], hand_b: list[str]) -> int:
    ea = evaluate([parse_card(c) for c in hand_a])
    eb = evaluate([parse_card(c) for c in hand_b])
    if ea > eb:
        return 1
    elif ea < eb:
        return -1
    return 0


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 6:
        print("Usage: python evaluator.py c1 c2 c3 c4 c5 [c6] [c7]")
        print("Example: python evaluator.py Ah Kh Qh Jh Th")
        sys.exit(1)
    cards = sys.argv[1:]
    hc, tb, name = evaluate_hand(cards)
    print("%s (class=%d, tiebreak=%s)" % (name, hc, tb))
