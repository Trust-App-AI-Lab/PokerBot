from __future__ import annotations
"""
Pot odds, implied odds, and EV calculator.

CLI: python odds.py <pot> <call_amount> <equity> [--implied <future_winnings>]
Example: python odds.py 200 50 0.35
"""

import sys


def pot_odds(pot: float, call_amount: float) -> dict:
    """
    Calculate pot odds.

    Args:
        pot: Current pot size (before hero calls)
        call_amount: Amount hero needs to call

    Returns:
        pot_odds as ratio and percentage
    """
    if call_amount <= 0:
        return {"pot_odds": 0.0, "pot_odds_pct": "0.0%", "note": "Free to see"}

    total_pot = pot + call_amount
    odds = call_amount / total_pot

    return {
        "pot_odds": round(odds, 4),
        "pot_odds_pct": f"{odds * 100:.1f}%",
        "ratio": f"1:{(total_pot - call_amount) / call_amount:.1f}",
        "need_equity": f"{odds * 100:.1f}%",
    }


def implied_odds(pot: float, call_amount: float, future_winnings: float) -> dict:
    """
    Calculate implied odds (accounting for expected future winnings).

    Args:
        pot: Current pot
        call_amount: Amount to call
        future_winnings: Expected additional winnings if you hit

    Returns:
        Implied odds and required equity
    """
    effective_pot = pot + call_amount + future_winnings
    odds = call_amount / effective_pot

    return {
        "implied_odds": round(odds, 4),
        "implied_odds_pct": f"{odds * 100:.1f}%",
        "effective_pot": effective_pot,
        "need_equity": f"{odds * 100:.1f}%",
    }


def ev_call(equity: float, pot: float, call_amount: float) -> dict:
    """
    EV of calling.

    EV = equity * (pot + call) - (1 - equity) * call
       = equity * pot - (1 - equity) * call ... wait
    Actually: EV = equity * (pot + call_amount) - call_amount

    When you call and win, you gain (pot + villain's bet = pot).
    When you call and lose, you lose call_amount.

    More precisely:
    EV(call) = equity × (pot + call_amount) - (1 - equity) × call_amount
             = equity × pot + equity × call - call + equity × call
             = equity × (pot + call_amount) - call_amount
    """
    ev = equity * (pot + call_amount) - call_amount

    return {
        "ev": round(ev, 2),
        "profitable": ev > 0,
        "breakeven_equity": round(call_amount / (pot + call_amount), 4) if (pot + call_amount) > 0 else 0,
    }


def ev_raise(
    equity: float,
    pot: float,
    raise_amount: float,
    fold_equity: float = 0.0,
) -> dict:
    """
    EV of raising (simplified).

    Considers two outcomes:
    1. Villain folds → we win current pot
    2. Villain calls → showdown with our equity against new pot

    Args:
        equity: Our equity if called
        pot: Current pot before our raise
        raise_amount: Our total raise amount
        fold_equity: Probability villain folds
    """
    # If villain folds
    ev_fold = pot  # We win current pot

    # If villain calls
    new_pot = pot + raise_amount * 2  # Simplified: villain matches our raise
    ev_call_part = equity * new_pot - raise_amount

    ev = fold_equity * ev_fold + (1 - fold_equity) * ev_call_part

    return {
        "ev": round(ev, 2),
        "ev_if_fold": round(ev_fold, 2),
        "ev_if_called": round(ev_call_part, 2),
        "fold_equity": fold_equity,
        "profitable": ev > 0,
    }


def outs_to_equity(outs: int, street: str = "flop") -> dict:
    """
    Quick approximation: outs → equity using Rule of 2 and 4.

    Args:
        outs: Number of outs
        street: "flop" (2 cards to come) or "turn" (1 card to come)
    """
    if street == "flop":
        approx = min(outs * 4, 100)  # Rule of 4
        # More accurate: 1 - (47-outs)/47 * (46-outs)/46
        exact = 1 - ((47 - outs) / 47) * ((46 - outs) / 46)
    else:
        approx = min(outs * 2, 100)  # Rule of 2
        exact = outs / 46

    return {
        "outs": outs,
        "street": street,
        "equity_approx": f"{approx}%",
        "equity_exact": f"{exact * 100:.1f}%",
    }


def spr(effective_stack: float, pot: float) -> dict:
    """
    Stack-to-Pot Ratio.
    SPR < 3: commit with top pair+
    SPR 3-6: cautious with one pair
    SPR > 10: speculative hands gain value
    """
    if pot <= 0:
        return {"spr": float("inf"), "guidance": "No pot yet"}

    ratio = effective_stack / pot
    if ratio < 3:
        guidance = "Low SPR — commit with top pair or better"
    elif ratio < 6:
        guidance = "Medium SPR — one pair hands are tricky, prefer sets+"
    elif ratio < 10:
        guidance = "Moderate SPR — position and draws matter more"
    else:
        guidance = "High SPR — speculative hands (suited connectors, small pairs) gain value"

    return {
        "spr": round(ratio, 1),
        "guidance": guidance,
    }


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python odds.py <pot> <call_amount> <equity> [--implied <future>]")
        print("Example: python odds.py 200 50 0.35")
        print("Example: python odds.py 200 50 0.20 --implied 300")
        sys.exit(1)

    pot_size = float(sys.argv[1])
    call_amt = float(sys.argv[2])
    eq = float(sys.argv[3])

    print("=== Pot Odds ===")
    po = pot_odds(pot_size, call_amt)
    for k, v in po.items():
        print(f"  {k}: {v}")

    print(f"\n=== EV of Calling (equity={eq:.1%}) ===")
    ev = ev_call(eq, pot_size, call_amt)
    for k, v in ev.items():
        print(f"  {k}: {v}")

    if "--implied" in sys.argv:
        idx = sys.argv.index("--implied")
        future = float(sys.argv[idx + 1])
        print(f"\n=== Implied Odds (future={future}) ===")
        io = implied_odds(pot_size, call_amt, future)
        for k, v in io.items():
            print(f"  {k}: {v}")
