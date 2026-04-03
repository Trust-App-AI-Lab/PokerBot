"""
Poker hand evaluator — zero dependencies.
Evaluates 5-7 card hands, returns a rank (lower = stronger).

Card format: "{rank}{suit}" e.g. "Ah", "Ts", "2c"
  Ranks: 2,3,4,5,6,7,8,9,T,J,Q,K,A
  Suits: s,h,d,c
"""

from itertools import combinations

RANKS = "23456789TJQKA"
RANK_MAP = {r: i for i, r in enumerate(RANKS)}  # 2=0 ... A=12

HAND_CLASSES = [
    "High Card",       # 0
    "One Pair",        # 1
    "Two Pair",        # 2
    "Three of a Kind", # 3
    "Straight",        # 4
    "Flush",           # 5
    "Full House",      # 6
    "Four of a Kind",  # 7
    "Straight Flush",  # 8
    "Royal Flush",     # 9
]


def parse_card(card_str: str) -> tuple[int, int]:
    """Parse card string to (rank_index, suit_index)."""
    rank_ch = card_str[0].upper()
    suit_ch = card_str[1].lower()
    rank = RANK_MAP[rank_ch]
    suit = "shdc".index(suit_ch)
    return (rank, suit)


def card_to_str(rank: int, suit: int) -> str:
    """Convert (rank_index, suit_index) back to string."""
    return RANKS[rank] + "shdc"[suit]


def full_deck() -> list[tuple[int, int]]:
    """Return all 52 cards as (rank, suit) tuples."""
    return [(r, s) for r in range(13) for s in range(4)]


def _evaluate_5(cards: list[tuple[int, int]]) -> tuple[int, list[int]]:
    """
    Evaluate exactly 5 cards.
    Returns (hand_class, tiebreakers) where lower hand_class is weaker.
    """
    ranks = sorted([c[0] for c in cards], reverse=True)
    suits = [c[1] for c in cards]

    is_flush = len(set(suits)) == 1

    # Check straight
    unique_ranks = sorted(set(ranks), reverse=True)
    is_straight = False
    straight_high = -1

    if len(unique_ranks) == 5:
        if unique_ranks[0] - unique_ranks[4] == 4:
            is_straight = True
            straight_high = unique_ranks[0]
        # Wheel: A-2-3-4-5
        elif unique_ranks == [12, 3, 2, 1, 0]:
            is_straight = True
            straight_high = 3  # 5-high straight

    # Count rank frequencies
    from collections import Counter
    freq = Counter(ranks)
    # Sort by (frequency desc, rank desc)
    freq_groups = sorted(freq.items(), key=lambda x: (x[1], x[0]), reverse=True)

    if is_straight and is_flush:
        if straight_high == 12:  # A-high straight flush
            return (9, [straight_high])  # Royal Flush
        return (8, [straight_high])  # Straight Flush

    if freq_groups[0][1] == 4:  # Four of a kind
        quad_rank = freq_groups[0][0]
        kicker = freq_groups[1][0]
        return (7, [quad_rank, kicker])

    if freq_groups[0][1] == 3 and freq_groups[1][1] == 2:  # Full house
        trip_rank = freq_groups[0][0]
        pair_rank = freq_groups[1][0]
        return (6, [trip_rank, pair_rank])

    if is_flush:
        return (5, ranks)

    if is_straight:
        return (4, [straight_high])

    if freq_groups[0][1] == 3:  # Three of a kind
        trip_rank = freq_groups[0][0]
        kickers = sorted([r for r, c in freq_groups[1:]], reverse=True)
        return (3, [trip_rank] + kickers)

    if freq_groups[0][1] == 2 and freq_groups[1][1] == 2:  # Two pair
        high_pair = max(freq_groups[0][0], freq_groups[1][0])
        low_pair = min(freq_groups[0][0], freq_groups[1][0])
        kicker = freq_groups[2][0]
        return (2, [high_pair, low_pair, kicker])

    if freq_groups[0][1] == 2:  # One pair
        pair_rank = freq_groups[0][0]
        kickers = sorted([r for r, c in freq_groups[1:]], reverse=True)
        return (1, [pair_rank] + kickers)

    # High card
    return (0, ranks)


def evaluate(cards: list[tuple[int, int]]) -> tuple[int, list[int]]:
    """
    Evaluate best 5-card hand from 5-7 cards.
    Returns (hand_class, tiebreakers).
    """
    if len(cards) < 5:
        raise ValueError(f"Need at least 5 cards, got {len(cards)}")
    if len(cards) == 5:
        return _evaluate_5(cards)

    best = None
    for combo in combinations(cards, 5):
        result = _evaluate_5(list(combo))
        if best is None or result > best:
            best = result
    return best


def evaluate_hand(card_strings: list[str]) -> tuple[int, list[int], str]:
    """
    High-level: evaluate from card strings.
    Returns (hand_class, tiebreakers, hand_name).
    """
    cards = [parse_card(c) for c in card_strings]
    hc, tb = evaluate(cards)
    return (hc, tb, HAND_CLASSES[hc])


def compare_hands(hand_a: list[str], hand_b: list[str]) -> int:
    """
    Compare two hands. Returns:
      1  if hand_a wins
      -1 if hand_b wins
      0  if tie
    """
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
        print("Usage: python evaluator.py card1 card2 card3 card4 card5 [card6] [card7]")
        print("Example: python evaluator.py Ah Kh Qh Jh Th")
        sys.exit(1)

    cards = sys.argv[1:]
    hc, tb, name = evaluate_hand(cards)
    print(f"{name} (class={hc}, tiebreak={tb})")
