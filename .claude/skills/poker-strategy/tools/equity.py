from __future__ import annotations
"""
Equity calculator — fully vectorized Monte Carlo (no Python per-sim loop).

Batch deals + batch evaluation using numpy.

CLI: python equity.py <hero_c1> <hero_c2> <villain_range> [board_cards...] [--sims N]
"""

import sys
import numpy as np
from range_parser import parse_range, RANGE_PRESETS

RANKS_STR = "23456789TJQKA"
SUIT_MAP = {'s': 0, 'h': 1, 'd': 2, 'c': 3}


def _card_int(card_str):
    return RANKS_STR.index(card_str[0].upper()) * 4 + SUIT_MAP[card_str[1].lower()]


def _score_batch(cards):
    """
    Fully vectorized hand evaluation.

    Args:
        cards: (N, 7) int32 array of card integers 0-51

    Returns:
        (N,) int64 array — higher = better hand
    """
    N = cards.shape[0]
    ranks = cards // 4   # (N, 7)  0-12
    suits = cards % 4    # (N, 7)  0-3

    # ── Rank histogram (N, 13) ──
    rank_hist = np.zeros((N, 13), dtype=np.int32)
    for j in range(7):
        np.add.at(rank_hist, (np.arange(N), ranks[:, j]), 1)

    # ── Suit histogram (N, 4) ──
    suit_hist = np.zeros((N, 4), dtype=np.int32)
    for j in range(7):
        np.add.at(suit_hist, (np.arange(N), suits[:, j]), 1)

    # ── Frequency-based hand class (vectorized) ──
    max_freq = rank_hist.max(axis=1)                    # (N,)
    n_pairs = (rank_hist == 2).sum(axis=1)              # (N,)
    n_trips = (rank_hist >= 3).sum(axis=1)              # (N,)

    hand_class = np.zeros(N, dtype=np.int64)
    hand_class[max_freq == 4] = 7                                              # quads
    hand_class[(n_trips >= 2) & (hand_class == 0)] = 6                         # two trips → FH
    hand_class[(n_trips >= 1) & (n_pairs >= 1) & (hand_class == 0)] = 6        # trip+pair → FH
    hand_class[(n_trips >= 1) & (hand_class == 0)] = 3                         # trips
    hand_class[(n_pairs >= 2) & (hand_class == 0)] = 2                         # two pair
    hand_class[(n_pairs >= 1) & (hand_class == 0)] = 1                         # one pair
    # 0 = high card

    # ── Tiebreaker score from weighted rank sorting ──
    # weight = freq * 14 + rank → sort desc → pack top 5 into int64
    weighted = rank_hist * 14 + np.arange(13, dtype=np.int32)[np.newaxis, :]
    weighted[rank_hist == 0] = -1
    sorted_w = -np.sort(-weighted, axis=1)  # descending sort
    top5 = sorted_w[:, :5].astype(np.int64)  # (N, 5)
    P = np.array([14**4, 14**3, 14**2, 14, 1], dtype=np.int64)
    tb_score = (top5 * P[np.newaxis, :]).sum(axis=1)

    scores = hand_class * np.int64(14**6) + tb_score

    # ── Straight detection (vectorized) ──
    rank_present = (rank_hist > 0).astype(np.int32)
    bit_vals = (1 << np.arange(13, dtype=np.int32))
    rank_bits = (rank_present * bit_vals[np.newaxis, :]).sum(axis=1)  # (N,)

    straight_high = np.full(N, -1, dtype=np.int32)
    for high in range(12, 3, -1):
        mask_val = np.int32(0b11111 << (high - 4))
        found = (straight_high == -1) & ((rank_bits & mask_val) == mask_val)
        straight_high[found] = high
    wheel = np.int32(0b1000000001111)
    found = (straight_high == -1) & ((rank_bits & wheel) == wheel)
    straight_high[found] = 3

    has_straight = straight_high >= 0

    # ── Flush detection ──
    flush_suit = np.argmax(suit_hist, axis=1).astype(np.int32)
    has_flush = suit_hist[np.arange(N), flush_suit] >= 5

    # ── Straight Flush ──
    check_sf = has_flush.copy()
    if check_sf.any():
        fi = np.where(check_sf)[0]
        flush_bits = np.zeros(len(fi), dtype=np.int32)
        for j in range(7):
            is_fs = suits[fi, j] == flush_suit[fi]
            flush_bits += np.where(is_fs, np.int32(1) << ranks[fi, j], np.int32(0))

        sf_high = np.full(len(fi), -1, dtype=np.int32)
        for high in range(12, 3, -1):
            mv = np.int32(0b11111 << (high - 4))
            f = (sf_high == -1) & ((flush_bits & mv) == mv)
            sf_high[f] = high
        f = (sf_high == -1) & ((flush_bits & wheel) == wheel)
        sf_high[f] = 3

        has_sf = sf_high >= 0
        if has_sf.any():
            sf_idx = fi[has_sf]
            sf_h = sf_high[has_sf].astype(np.int64)
            royal = sf_h == 12
            scores[sf_idx[royal]] = np.int64(9) * np.int64(14**6) + np.int64(12)
            scores[sf_idx[~royal]] = np.int64(8) * np.int64(14**6) + sf_h[~royal]

        # ── Regular Flush (non-SF): need top-5 suited ranks ──
        flush_no_sf = fi[~has_sf] if has_sf.any() else fi
        if len(flush_no_sf) > 0:
            # Build flush rank matrix: for each hand, ranks of flush-suit cards
            # Max 7 flush cards possible, padded with -1
            flush_rank_matrix = np.full((len(flush_no_sf), 7), -1, dtype=np.int32)
            for j in range(7):
                is_fs = suits[flush_no_sf, j] == flush_suit[flush_no_sf]
                r_vals = np.where(is_fs, ranks[flush_no_sf, j], -1)
                flush_rank_matrix[:, j] = r_vals
            # Sort descending, take top 5
            flush_rank_matrix = -np.sort(-flush_rank_matrix, axis=1)
            ftop5 = flush_rank_matrix[:, :5].astype(np.int64)
            flush_scores = np.int64(5) * np.int64(14**6) + (ftop5 * P[np.newaxis, :]).sum(axis=1)
            scores[flush_no_sf] = flush_scores

    # ── Straight (non-flush): override score ──
    straight_only = has_straight & (~has_flush)
    if straight_only.any():
        si = np.where(straight_only)[0]
        scores[si] = np.int64(4) * np.int64(14**6) + straight_high[si].astype(np.int64)

    return scores


def calc_equity(hero, villain_range, board=None, sims=10000):
    """
    Fully vectorized Monte Carlo equity. No Python per-sim loop.
    """
    if board is None:
        board = []

    hero_ints = np.array([_card_int(c) for c in hero], dtype=np.int32)
    board_ints = np.array([_card_int(c) for c in board], dtype=np.int32)
    dead_set = set(hero_ints.tolist()) | set(board_ints.tolist())

    # Villain range as (N_v, 2) array
    v_list = []
    for v1, v2 in villain_range:
        i1, i2 = _card_int(v1), _card_int(v2)
        if i1 not in dead_set and i2 not in dead_set:
            v_list.append([i1, i2])
    if not v_list:
        return {"equity": 0.0, "win": 0, "tie": 0, "lose": 0, "total": 0,
                "error": "No valid villain combos"}

    v_arr = np.array(v_list, dtype=np.int32)  # (N_v, 2)
    available = np.array([i for i in range(52) if i not in dead_set], dtype=np.int32)
    n_avail = len(available)
    cards_needed = 5 - len(board_ints)

    # ── Batch deal: villain picks ──
    vi = np.random.randint(0, len(v_arr), size=sims)
    villain_cards = v_arr[vi]  # (sims, 2)

    # ── Batch deal: runout via argsort shuffle ──
    # Shuffle available deck for each sim, take first cards_needed
    rand = np.random.random((sims, n_avail))
    shuffled_idx = np.argsort(rand, axis=1)[:, :cards_needed]  # (sims, cards_needed)
    runout = available[shuffled_idx]  # (sims, cards_needed)

    # ── Reject sims where runout conflicts with villain cards ──
    # conflict = any runout card == any villain card
    conflict = np.any(
        runout[:, :, np.newaxis] == villain_cards[:, np.newaxis, :],
        axis=(1, 2)
    )  # (sims,)

    max_retries = 10
    for _ in range(max_retries):
        if not conflict.any():
            break
        n_redo = int(conflict.sum())
        new_rand = np.random.random((n_redo, n_avail))
        new_idx = np.argsort(new_rand, axis=1)[:, :cards_needed]
        runout[conflict] = available[new_idx]
        vc_sub = villain_cards[conflict]
        ro_sub = runout[conflict]
        new_conflict = np.any(
            ro_sub[:, :, np.newaxis] == vc_sub[:, np.newaxis, :],
            axis=(1, 2)
        )
        ci = np.where(conflict)[0]
        conflict[ci] = new_conflict

    # ── Assemble 7-card hands ──
    hero_tile = np.tile(hero_ints, (sims, 1))  # (sims, 2)
    if len(board_ints) > 0:
        board_tile = np.tile(board_ints, (sims, 1))  # (sims, len(board))
        hero_7 = np.concatenate([hero_tile, board_tile, runout], axis=1)
        villain_7 = np.concatenate([villain_cards, board_tile, runout], axis=1)
    else:
        hero_7 = np.concatenate([hero_tile, runout], axis=1)
        villain_7 = np.concatenate([villain_cards, runout], axis=1)

    # ── Batch evaluate ──
    hero_scores = _score_batch(hero_7)
    villain_scores = _score_batch(villain_7)

    # ── Compare ──
    wins = int((hero_scores > villain_scores).sum())
    ties = int((hero_scores == villain_scores).sum())
    losses = int((hero_scores < villain_scores).sum())
    total = wins + ties + losses
    equity = (wins + ties * 0.5) / total if total > 0 else 0

    return {
        "equity": round(equity, 4),
        "equity_pct": "%.1f%%" % (equity * 100),
        "win": wins,
        "tie": ties,
        "lose": losses,
        "total": total,
        "villain_combos": len(v_list),
    }


def hand_vs_hand(hero, villain, board=None, sims=10000):
    return calc_equity(hero, [(villain[0], villain[1])], board, sims)


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) < 3:
        print("Usage: python equity.py <c1> <c2> <villain_range> [board...] [--sims N]")
        print('Example: python equity.py Ah Kh "QQ+" Td 7d 2c --sims 10000')
        print("Preset ranges: %s" % list(RANGE_PRESETS.keys()))
        sys.exit(1)

    sims = 10000
    if "--sims" in args:
        idx = args.index("--sims")
        sims = int(args[idx + 1])
        args = args[:idx] + args[idx + 2:]

    hero = [args[0], args[1]]
    range_str = args[2]
    board = args[3:] if len(args) > 3 else []

    if range_str in RANGE_PRESETS:
        print("Using preset: %s = %s" % (range_str, RANGE_PRESETS[range_str]))
        range_str = RANGE_PRESETS[range_str]

    dead = hero + board
    villain_range = parse_range(range_str, dead)

    print("Hero:    %s %s" % (hero[0], hero[1]))
    print("Villain: %s (%d combos)" % (range_str, len(villain_range)))
    if board:
        print("Board:   %s" % ' '.join(board))
    print("Sims:    %d" % sims)
    print()

    result = calc_equity(hero, villain_range, board, sims)
    print("Equity:  %s" % result['equity_pct'])
    print("Win:     %d (%.1f%%)" % (result['win'], result['win']/result['total']*100))
    print("Tie:     %d (%.1f%%)" % (result['tie'], result['tie']/result['total']*100))
    print("Lose:    %d (%.1f%%)" % (result['lose'], result['lose']/result['total']*100))
