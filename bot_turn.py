import json, urllib.request, sys

SERVER = "http://localhost:3457"
BOT = "Shark_Alice"

with urllib.request.urlopen(SERVER + "/state?player=" + BOT) as r:
    state = json.loads(r.read())

if state.get("currentActor") != BOT:
    print("not my turn")
    sys.exit(0)

phase = state["phase"]
cards = state.get("myCards", [])
call_amt = state.get("callAmount", 0)
pot = state["pot"]
stack = state["myStack"]
pos = state.get("positions", {}).get(BOT, "")
current_bet = state.get("currentBet", 0)
min_raise = state.get("minRaise", 40)
max_raise = state.get("maxRaise", stack)
board = state.get("communityCards", [])

print(f"Phase={phase} Cards={cards} Pos={pos} Pot={pot} Call={call_amt} Stack={stack} Board={board}")

RANKS = "23456789TJQKA"

def rank(c):
    return RANKS.index(c[:-1])

def suited(c1, c2):
    return c1[-1] == c2[-1]

def is_pair(c1, c2):
    return c1[:-1] == c2[:-1]

action = None

if len(cards) == 2:
    r1, r2 = rank(cards[0]), rank(cards[1])
    hi, lo = max(r1, r2), min(r1, r2)
    s2 = suited(cards[0], cards[1])
    paired = is_pair(cards[0], cards[1])

    if phase == "preflop":
        # TT+, AK, AQ = premium
        is_premium = (paired and hi >= 8) or (hi == 12 and lo >= 10)
        # 77-99, suited broadways, suited aces, KQo, KJo, QJo = strong
        is_strong = (paired and hi >= 5) or (s2 and hi >= 10 and lo >= 7) or (s2 and hi == 12 and lo >= 7) or (hi >= 11 and lo >= 9)
        # BTN/CO playable: suited connectors, suited kings, any pair, broadways
        is_playable = s2 or paired or (hi >= 10 and lo >= 8)

        # Detect if facing a real raise (above BB level) or just posting
        big_blind = state.get("bigBlind", 20)
        actions_list = state.get("actions", [])
        raised = any(a.get("action") == "raise" for a in actions_list)
        facing_raise = raised and current_bet > big_blind

        if not facing_raise:
            # Unraised pot — treat as open opportunity
            open_size = 50 if pos in ("BTN", "SB") else 60
            if is_premium or is_strong:
                action = dict(player=BOT, action="raise", amount=open_size)
            elif is_playable and pos in ("BTN", "CO", "SB"):
                action = dict(player=BOT, action="raise", amount=open_size)
            elif call_amt == 0:
                action = dict(player=BOT, action="check")
            else:
                action = dict(player=BOT, action="fold")
        else:
            pot_odds = call_amt / (pot + call_amt)
            if is_premium:
                three_bet = min(max(current_bet * 3, min_raise), max_raise)
                action = dict(player=BOT, action="raise", amount=three_bet)
            elif is_strong and pot_odds < 0.30:
                action = dict(player=BOT, action="call")
            elif is_playable and pot_odds < 0.20 and pos == "BTN":
                action = dict(player=BOT, action="call")
            else:
                action = dict(player=BOT, action="fold")
    else:
        # Postflop decision
        num_board = len(board)

        # Evaluate made hand strength on board
        top_card = rank(board[0]) if board else 0
        board_ranks = [rank(c) for c in board]
        has_pair = paired
        hits_top_pair = any(rank(c) == hi for c in board) and not paired
        hits_pair = any(rank(c) == hi or rank(c) == lo for c in board) and not paired
        has_flush_draw = s2 and sum(1 for c in board if c[-1] == cards[0][-1]) >= 2
        has_nut_flush_draw = s2 and hi == 12 and sum(1 for c in board if c[-1] == cards[0][-1]) >= 2

        # Classify hand strength
        # Strong: top pair top kicker, overpair, two pair+, nut flush draw
        is_strong_hand = has_pair or hits_top_pair or has_nut_flush_draw
        # Decent: middle pair, pair+draw, flush draw
        is_decent_hand = hits_pair or has_flush_draw

        if call_amt == 0:
            # Betting opportunity (checked to us or we're first)
            if is_strong_hand:
                # Value bet: 50-66% pot from any position
                bet_size = max(int(pot * 0.55), 20)
                bet_size = min(bet_size, stack)
                action = dict(player=BOT, action="bet", amount=bet_size)
            elif is_decent_hand and pos in ("BTN", "CO"):
                # Thin value / probe bet in position only
                bet_size = max(int(pot * 0.40), 20)
                bet_size = min(bet_size, stack)
                action = dict(player=BOT, action="bet", amount=bet_size)
            else:
                action = dict(player=BOT, action="check")
        else:
            pot_odds = call_amt / (pot + call_amt)
            if is_strong_hand and pot_odds < 0.45:
                action = dict(player=BOT, action="call")
            elif is_decent_hand and pot_odds < 0.25:
                action = dict(player=BOT, action="call")
            else:
                action = dict(player=BOT, action="fold")
else:
    action = dict(player=BOT, action="check") if call_amt == 0 else dict(player=BOT, action="fold")

print(f"Action: {action}")
data = json.dumps(action).encode()
req = urllib.request.Request(
    SERVER + "/action",
    data=data,
    headers={"Content-Type": "application/json"},
    method="POST"
)
with urllib.request.urlopen(req) as r:
    print("Result:", r.read().decode())
