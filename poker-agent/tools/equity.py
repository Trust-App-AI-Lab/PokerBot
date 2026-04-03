"""
Equity calculator — Monte Carlo simulation.

Calculates win probability of hero's hand vs a villain range.
Supports hand-vs-hand and hand-vs-range.

CLI: python equity.py <hero_c1> <hero_c2> <villain_range> [board_cards...] [--sims N]
Example: python equity.py Ah Kh "QQ+, AKs" Td 7d 2c --sims 10000
"""

import sys
import random
from evaluator import parse_card, full_deck, evaluate, card_to_str
from range_parser import parse_range, RANGE_PRESETS


def calc_equity(
    hero: list[str],
    villain_range: list[tuple[str, str]],
    board: list[str] = None,
    sims: int = 10000,
) -> dict:
    """
    Monte Carlo equity calculation.

    Args:
        hero: Hero's hole cards, e.g. ["Ah", "Kh"]
        villain_range: List of (card1, card2) tuples for villain's range
        board: Community cards already dealt (0-5), e.g. ["Td", "7d", "2c"]
        sims: Number of simulations

    Returns:
        dict with equity (0-1), win/tie/lose counts
    """
    if board is None:
        board = []

    hero_parsed = [parse_card(c) for c in hero]
    board_parsed = [parse_card(c) for c in board]

    # Dead cards: hero + board
    dead_set = set(hero) | set(board)

    # Filter villain range: remove combos that conflict with hero/board
    valid_villain = []
    for v1, v2 in villain_range:
        if v1 not in dead_set and v2 not in dead_set:
            valid_villain.append((v1, v2))

    if not valid_villain:
        return {"equity": 0.0, "win": 0, "tie": 0, "lose": 0, "total": 0,
                "error": "No valid villain combos after removing dead cards"}

    # Build available deck (exclude hero + board)
    all_cards = full_deck()
    hero_board_set = set(hero_parsed + board_parsed)
    available_base = [c for c in all_cards if c not in hero_board_set]

    cards_needed = 5 - len(board_parsed)  # Community cards still to come
    wins = 0
    ties = 0
    losses = 0

    for _ in range(sims):
        # Pick a random villain hand from range
        v1_str, v2_str = random.choice(valid_villain)
        v1 = parse_card(v1_str)
        v2 = parse_card(v2_str)

        # Remove villain cards from available deck
        villain_set = {v1, v2}
        available = [c for c in available_base if c not in villain_set]

        # Deal remaining community cards
        runout = random.sample(available, cards_needed)
        full_board = board_parsed + runout

        # Evaluate
        hero_hand = hero_parsed + full_board
        villain_hand = [v1, v2] + full_board

        hero_eval = evaluate(hero_hand)
        villain_eval = evaluate(villain_hand)

        if hero_eval > villain_eval:
            wins += 1
        elif hero_eval < villain_eval:
            losses += 1
        else:
            ties += 1

    total = wins + ties + losses
    equity = (wins + ties * 0.5) / total if total > 0 else 0

    return {
        "equity": round(equity, 4),
        "equity_pct": f"{equity * 100:.1f}%",
        "win": wins,
        "tie": ties,
        "lose": losses,
        "total": total,
        "villain_combos": len(valid_villain),
    }


def hand_vs_hand(
    hero: list[str],
    villain: list[str],
    board: list[str] = None,
    sims: int = 10000,
) -> dict:
    """Convenience: equity of hero hand vs specific villain hand."""
    return calc_equity(hero, [(villain[0], villain[1])], board, sims)


if __name__ == "__main__":
    args = sys.argv[1:]

    if len(args) < 3:
        print("Usage: python equity.py <c1> <c2> <villain_range> [board...] [--sims N]")
        print('Example: python equity.py Ah Kh "QQ+" Td 7d 2c --sims 10000')
        print(f"\nPreset ranges: {list(RANGE_PRESETS.keys())}")
        sys.exit(1)

    # Parse --sims
    sims = 10000
    if "--sims" in args:
        idx = args.index("--sims")
        sims = int(args[idx + 1])
        args = args[:idx] + args[idx + 2:]

    hero = [args[0], args[1]]
    range_str = args[2]
    board = args[3:] if len(args) > 3 else []

    # Handle presets
    if range_str in RANGE_PRESETS:
        print(f"Using preset: {range_str} = {RANGE_PRESETS[range_str]}")
        range_str = RANGE_PRESETS[range_str]

    # Parse range, excluding hero + board as dead
    dead = hero + board
    villain_range = parse_range(range_str, dead)

    print(f"Hero:    {hero[0]} {hero[1]}")
    print(f"Villain: {range_str} ({len(villain_range)} combos)")
    if board:
        print(f"Board:   {' '.join(board)}")
    print(f"Sims:    {sims}")
    print()

    result = calc_equity(hero, villain_range, board, sims)
    print(f"Equity:  {result['equity_pct']}")
    print(f"Win:     {result['win']} ({result['win']/result['total']*100:.1f}%)")
    print(f"Tie:     {result['tie']} ({result['tie']/result['total']*100:.1f}%)")
    print(f"Lose:    {result['lose']} ({result['lose']/result['total']*100:.1f}%)")
