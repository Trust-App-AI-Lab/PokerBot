#!/usr/bin/env python3
"""
Poker Decision Engine — Claude as the Brain

Reads turn.json / writes action.json to talk to bridge-live.js or orchestrator.js.
All files live in PokerBot/bot_profiles/{BOT_NAME}/.

Usage:
    python decide.py                  # read current state from state.json / turn.json
    python decide.py --act fold       # write action.json (bridge picks it up)
    python decide.py --act raise 200  # write raise action
    python decide.py --act call       # write call action
    python decide.py --chat "gg wp"   # send chat message
    python decide.py --host start     # host: start game (HTTP)
    python decide.py --host stop      # host: stop game after current hand
    python decide.py --host pause     # host: pause game
    python decide.py --host resume    # host: resume game
    python decide.py --host next      # host: deal next hand
    python decide.py --approve <id> [stack]  # host: accept player join request
    python decide.py --kick <id>      # host: remove player from table
    python decide.py --auto           # read state + auto-play with heuristic
    python decide.py --history [n]    # show last n history records

Prerequisites: bridge-live.js or orchestrator.js must be running
Dependencies: Python stdlib only (json, os, sys, time)
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR   = os.path.join(SCRIPT_DIR, "..")                # pokernow-bot/
PROJECT_ROOT = os.path.join(ENGINE_DIR, "..")                 # PokerBot/

# Load bot name from .env
import re as _re
_env_file = os.path.join(ENGINE_DIR, ".env")
BOT_NAME = "ARIA_Bot"
if os.path.exists(_env_file):
    with open(_env_file) as _f:
        for _line in _f:
            _m = _re.match(r'BOT_NAME\s*=\s*(.+)', _line.strip())
            if _m:
                BOT_NAME = _m.group(1).strip()

# All files in bot_profiles/{BOT_NAME}/
PROFILE_DIR = os.path.join(PROJECT_ROOT, "bot_profiles", BOT_NAME)
TURN_FILE    = os.path.join(PROFILE_DIR, "turn.json")
ACTION_FILE  = os.path.join(PROFILE_DIR, "action.json")
STATE_FILE   = os.path.join(PROFILE_DIR, "state.json")
HISTORY_FILE = os.path.join(PROFILE_DIR, "history.jsonl")


def log_history(entry_type, data):
    """Append a line to history.jsonl."""
    record = {
        "time": datetime.now(timezone.utc).isoformat(),
        "type": entry_type,
    }
    record.update(data)
    try:
        with open(HISTORY_FILE, "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass  # don't break gameplay over logging


# ── File-based communication ─────────────────────

def read_file_json(filepath):
    """Read a JSON file, return dict or None."""
    try:
        if os.path.exists(filepath):
            with open(filepath, "r") as f:
                raw = f.read().strip()
            if raw:
                return json.loads(raw)
    except Exception:
        pass
    return None


def get_status():
    """Read game state from turn.json or state.json (written by bridge-live/orchestrator)."""
    # Prefer turn.json (has turnInfo), fall back to state.json
    ctx = read_file_json(TURN_FILE)
    if ctx:
        ctx["_source"] = "turn.json"
        return ctx

    ctx = read_file_json(STATE_FILE)
    if ctx:
        ctx["_source"] = "state.json"
        return ctx

    return None


VALID_ACTIONS = {
    # Game actions
    "fold":           {"required": []},
    "check":          {"required": []},
    "call":           {"required": []},
    "raise":          {"required": ["amount"]},
    "bet":            {"required": ["amount"]},
    # Seat actions
    "sit":            {"required": [], "optional": ["seat", "stack"]},
    "request_seat":   {"required": [], "optional": ["seat", "stack"]},
    "sit_back":       {"required": []},
    "leave_seat":     {"required": []},
    "stand_up":       {"required": []},
    # Chat
    "chat":           {"required": ["message"]},
    # Host actions
    "start_game":     {"required": []},
    "stop_game":      {"required": []},
    "pause":          {"required": []},
    "resume":         {"required": []},
    "next_hand":      {"required": []},
    "approve_player": {"required": ["player_id"]},
    "remove_player":  {"required": ["player_id"]},
}


def validate_action(payload):
    """Validate action payload. Returns error string or None if valid."""
    if not isinstance(payload, dict):
        return "Action must be a dict"
    act = payload.get("action", "")
    if not act:
        return "Missing 'action' field"
    if act not in VALID_ACTIONS:
        return f"Unknown action '{act}'. Valid: {', '.join(VALID_ACTIONS.keys())}"
    spec = VALID_ACTIONS[act]
    for field in spec["required"]:
        val = payload.get(field)
        if val is None or val == "":
            return f"Action '{act}' requires '{field}'"
    if act in ("raise", "bet"):
        amt_raw = payload.get("amount")
        if amt_raw is None or amt_raw == "":
            return f"Action '{act}' requires a positive amount"
        try:
            amt = int(amt_raw)
            if amt <= 0:
                return f"Action '{act}' requires a positive amount"
        except (ValueError, TypeError):
            return f"Action '{act}' requires a positive amount"
    return None


def send_action(action, amount=None):
    """Write action.json for bridge-live/orchestrator to pick up. Validates format first."""
    payload = {"action": action}
    if amount is not None:
        payload["amount"] = int(amount)

    # Validate before writing
    error = validate_action(payload)
    if error:
        print(f"Invalid action: {error}", file=sys.stderr)
        return False

    try:
        with open(ACTION_FILE, "w") as f:
            json.dump(payload, f)
        print(f"Wrote action.json: {action}{f' ${int(amount)}' if amount else ''}")
    except Exception as e:
        print(f"Failed to write action.json: {e}", file=sys.stderr)
        return False

    # Log to history
    log_history("action", {
        "action": action,
        "amount": int(amount) if amount is not None else None,
        "ok": True,
    })

    # Wait briefly and confirm bridge picked it up
    time.sleep(1.5)
    if os.path.exists(ACTION_FILE):
        print("  (action.json still exists — bridge/orchestrator may not be running!)")
        return False
    else:
        print("  Action executed")
        return True


def send_host_action(host_action):
    """Write action.json with a host command."""
    action_map = {
        'start': 'start_game',
        'stop': 'stop_game',
        'pause': 'pause',
        'resume': 'resume',
        'next': 'next_hand',
    }
    act = action_map.get(host_action)
    if not act:
        print(f"Unknown host action: {host_action}")
        print(f"Available: {', '.join(action_map.keys())}")
        return False

    payload = {"action": act}
    try:
        with open(ACTION_FILE, "w") as f:
            json.dump(payload, f)
        print(f"Wrote action.json: host {host_action} ({act})")
    except Exception as e:
        print(f"Failed to write action.json: {e}", file=sys.stderr)
        return False

    log_history("host_action", {"action": act, "ok": True})

    time.sleep(2.0)
    if os.path.exists(ACTION_FILE):
        print("  (action.json still exists — bridge/orchestrator may not be running!)")
        return False
    else:
        print(f"  Host action '{host_action}' executed")
        return True


def send_chat(message):
    """Write action.json with a chat command."""
    payload = {"action": "chat", "message": message}

    try:
        with open(ACTION_FILE, "w") as f:
            json.dump(payload, f)
        print(f"Wrote action.json: chat \"{message}\"")
    except Exception as e:
        print(f"Failed to write action.json: {e}", file=sys.stderr)
        return False

    log_history("chat", {"message": message, "ok": True})

    time.sleep(1.5)
    if os.path.exists(ACTION_FILE):
        print("  (action.json still exists — bridge/orchestrator may not be running!)")
        return False
    else:
        print("  Chat sent")
        return True


def format_hand(ctx):
    """Format the game state as a readable string for Claude to analyze."""
    if not ctx:
        return "No game state available."

    cards = " ".join(ctx.get("myCards", [])) or "(none)"
    board = " ".join(ctx.get("communityCards", [])) or "(none)"
    phase = ctx.get("phase", "unknown")
    pot   = ctx.get("pot", 0)
    stack = ctx.get("myStack", 0)

    call_amt  = ctx.get("callAmount", 0)
    min_raise = ctx.get("minRaise", 0)
    max_raise = ctx.get("maxRaise", 0)

    # If turnInfo exists, prefer those values
    turn = ctx.get("turnInfo", {})
    if turn:
        call_amt  = turn.get("callAmount", call_amt)
        min_raise = turn.get("minRaise", min_raise)
        max_raise = turn.get("maxRaise", max_raise)

    players = ctx.get("players", [])
    active = [p for p in players if not p.get("folded") and p.get("status") != "watching"]

    is_my_turn = ctx.get("isMyTurn", False)

    lines = [
        f"{'★ YOUR TURN ★' if is_my_turn else '(not your turn)'}",
        f"Phase:    {phase.upper()}",
        f"Cards:    {cards}",
        f"Board:    {board}",
        f"Pot:      ${pot}",
        f"Stack:    ${stack}",
        f"Call:     ${call_amt}",
        f"Raise:    ${min_raise} - ${max_raise}",
        f"Active:   {len(active)} players",
        "",
        "Players:",
    ]
    for p in players:
        marker = ">>>" if p.get("isMe") else "   "
        fold_tag = " [FOLDED]" if p.get("folded") else ""
        bet_tag  = f" bet:${p.get('bet', 0)}" if p.get("bet") else ""
        cards_tag = f" [{' '.join(p['cards'])}]" if p.get("cards") else ""
        lines.append(f"  {marker} {p.get('name', '?')}: ${p.get('stack', 0)}{bet_tag}{fold_tag}{cards_tag}")

    # Full action history for this hand (accumulated, not truncated)
    actions = ctx.get("actions", [])
    if actions:
        lines.append("")
        lines.append("This hand's actions (full history):")
        current_phase = None
        for a in actions:
            phase = a.get("phase", "")
            if phase != current_phase:
                current_phase = phase
                lines.append(f"  --- {phase.upper()} ---")
            amt = f" ${a['amount']}" if a.get("amount") else ""
            lines.append(f"    {a.get('actor', '?')}: {a.get('action', '?')}{amt}")

    if is_my_turn:
        if call_amt == 0:
            lines.append(f"\nAvailable: check | raise (${min_raise}-${max_raise}) | fold")
        else:
            lines.append(f"\nAvailable: fold | call ${call_amt} | raise (${min_raise}-${max_raise})")

    # Recent hands summary (from bridge-live.js via turn.json)
    recent_hands = ctx.get("recentHands", [])
    if recent_hands:
        lines.append(f"\n{'='*50}")
        lines.append(f"RECENT HANDS ({len(recent_hands)} hands):")
        lines.append(f"{'='*50}")
        for i, h in enumerate(recent_hands):
            cards = " ".join(h.get("myCards", []) or [])
            board = " ".join(h.get("board", []) or [])
            pot = h.get("pot", 0)
            results = h.get("results", [])
            res_str = ", ".join(f"{r['winner']} wins ${r['amount']}" for r in results) if results else "?"
            my_actions = " → ".join(
                (a['action'] + (f" ${a['amount']}" if a.get('amount') else ''))
                for a in h.get("actions", [])
            )
            opp_cards = ""
            for oc in h.get("opponentCards", []):
                opp_cards += f" | {oc['name']}: {' '.join(oc['cards'])}"

            stack_change = ""
            if h.get("myStack") and h.get("endStack"):
                diff = h["endStack"] - h["myStack"]
                stack_change = f" ({'+' if diff >= 0 else ''}{diff})"

            lines.append(f"  Hand {i+1}: [{cards}] board=[{board}] pot=${pot}")
            lines.append(f"    My actions: {my_actions or 'none'}")
            lines.append(f"    Result: {res_str}{stack_change}{opp_cards}")

    # Chat messages
    chat_msgs = ctx.get("chatMessages", [])
    if chat_msgs:
        lines.append(f"\n{'='*50}")
        lines.append("CHAT:")
        lines.append(f"{'='*50}")
        for m in chat_msgs[-10:]:
            t = m.get("at", "")[:19].replace("T", " ") if m.get("at") else ""
            lines.append(f"  [{t}] {m.get('playerName', '?')}: {m.get('message', '')}")

    return "\n".join(lines)


# ── Heuristic fallback ────────────────────────────
def heuristic_decide(ctx):
    """Simple rule-based strategy as safety net."""
    cards = ctx.get("myCards", [])
    call_amount = ctx.get("callAmount", 0) or 0
    turn = ctx.get("turnInfo", {})
    if turn:
        call_amount = turn.get("callAmount", call_amount) or 0

    pot   = ctx.get("pot", 0)
    stack = ctx.get("myStack", 1000)
    bb    = ctx.get("bigBlind", 20)
    min_raise = turn.get("minRaise", ctx.get("minRaise", bb * 2))

    # Extract ranks from cards like ["Ah", "Kd"]
    ranks = tuple(c[0].upper() for c in cards) if len(cards) == 2 else ("", "")
    suits = tuple(c[1].lower() for c in cards) if len(cards) == 2 else ("", "")
    is_pair = ranks[0] == ranks[1]

    rank_order = "23456789TJQKA"
    rank_combo = "".join(sorted(ranks, key=lambda r: rank_order.index(r) if r in rank_order else -1, reverse=True))

    is_premium = rank_combo in ("AA", "KK", "QQ") or rank_combo == "AK"
    is_good    = rank_combo in ("JJ", "TT") or rank_combo in ("AQ", "AJ", "KQ")

    pot_odds = call_amount / (pot + call_amount) if call_amount > 0 else 0

    if call_amount == 0:
        if is_premium:
            return "raise", min(int(pot * 0.75 + bb * 3), stack)
        if is_good:
            return "raise", min(int(pot * 0.5 + bb * 2.5), stack)
        return "check", None
    else:
        if is_premium:
            return "raise", min(call_amount * 3, stack)
        if is_good and pot_odds < 0.3:
            return "call", None
        if is_pair and pot_odds < 0.15:
            return "call", None
        if pot_odds > 0.25 or call_amount > stack * 0.15:
            return "fold", None
        return "call", None


# ── CLI ───────────────────────────────────────────
def show_history(n=20):
    """Display last n history records."""
    if not os.path.exists(HISTORY_FILE):
        print("No history yet.")
        return
    with open(HISTORY_FILE, "r") as f:
        lines = f.readlines()
    for line in lines[-n:]:
        try:
            r = json.loads(line)
            t = r.get("time", "?")[:19].replace("T", " ")
            typ = r.get("type", "?")
            if typ == "hand_start":
                players = r.get("players", [])
                names = [p["name"] for p in players]
                bb = r.get("bigBlind", "?")
                print(f"\n  {'='*60}")
                print(f"  {t}  NEW HAND  blinds={bb}  players: {', '.join(names)}")
                print(f"  {'='*60}")
            elif typ == "hand_end":
                results = r.get("results", [])
                cards = " ".join(r.get("myCards", []) or [])
                board = " ".join(r.get("board", []) or [])
                res_str = ", ".join(f"{w['winner']} wins ${w['amount']}" for w in results) if results else "unknown"
                players = r.get("players", [])
                shown = [f"{p['name']}: {' '.join(p['cards'])}" for p in players if p.get("cards")]
                shown_str = f"  shown: {', '.join(shown)}" if shown else ""
                print(f"  {t}  END HAND  cards={cards}  board={board}  pot=${r.get('pot',0)}  result: {res_str}{shown_str}")
                print(f"  {'-'*60}")
            elif typ == "state":
                turn_mark = " ★" if r.get("isMyTurn") else ""
                cards = " ".join(r.get("myCards", []) or [])
                board = " ".join(r.get("board", []) or [])
                players = r.get("players", [])
                opponents = [p["name"] for p in players if not p.get("isMe") and not p.get("folded")]
                opp_str = f"  vs {', '.join(opponents)}" if opponents else ""
                print(f"  {t}  {r.get('phase','?'):10s}  cards={cards or '-':6s}  board={board or '-':18s}  pot=${r.get('pot',0):<6}  stack=${r.get('myStack',0)}{turn_mark}{opp_str}")
            elif typ == "action":
                amt = f" ${r['amount']}" if r.get("amount") else ""
                ok = "OK" if r.get("ok") else "FAIL"
                print(f"  {t}  >>> {r.get('action','?')}{amt}  [{ok}]")
            else:
                print(f"  {t}  {json.dumps(r)}")
        except Exception:
            print(f"  {line.strip()}")


def main():
    args = sys.argv[1:]

    # --history [n]
    if "--history" in args:
        idx = args.index("--history")
        n = int(args[idx + 1]) if idx + 1 < len(args) and args[idx + 1].isdigit() else 20
        show_history(n)
        sys.exit(0)

    # --approve <playerId> [stack]: accept player join request
    if "--approve" in args:
        idx = args.index("--approve")
        if idx + 1 >= len(args):
            print("Usage: --approve <playerID> [stack]")
            sys.exit(1)
        pid = args[idx + 1]
        stack = int(args[idx + 2]) if idx + 2 < len(args) and args[idx + 2].isdigit() else 1000
        payload = {"action": "approve_player", "player_id": pid, "stack": stack}
        try:
            with open(ACTION_FILE, "w") as f:
                json.dump(payload, f)
            print(f"Wrote action.json: approve player {pid} stack={stack}")
        except Exception as e:
            print(f"Failed: {e}", file=sys.stderr)
            sys.exit(1)
        time.sleep(2.0)
        if os.path.exists(ACTION_FILE):
            print("  (action.json still exists — bridge/orchestrator may not be running!)")
        else:
            print("  Player approved")
        sys.exit(0)

    # --kick <playerId>: remove player from table
    if "--kick" in args:
        idx = args.index("--kick")
        if idx + 1 >= len(args):
            print("Usage: --kick <playerID>")
            sys.exit(1)
        pid = args[idx + 1]
        payload = {"action": "remove_player", "player_id": pid}
        try:
            with open(ACTION_FILE, "w") as f:
                json.dump(payload, f)
            print(f"Wrote action.json: remove player {pid}")
        except Exception as e:
            print(f"Failed: {e}", file=sys.stderr)
            sys.exit(1)
        time.sleep(2.0)
        if os.path.exists(ACTION_FILE):
            print("  (action.json still exists — bridge/orchestrator may not be running!)")
        else:
            print("  Player removed")
        sys.exit(0)

    # --sit [seat] [stack]: request seat via action.json
    if "--sit" in args:
        idx = args.index("--sit")
        seat = int(args[idx + 1]) if idx + 1 < len(args) and args[idx + 1].isdigit() else None
        stack = int(args[idx + 2]) if idx + 2 < len(args) and args[idx + 2].isdigit() else None
        payload = {"action": "sit"}
        if seat: payload["seat"] = seat
        if stack: payload["stack"] = stack
        error = validate_action(payload)
        if error:
            print(f"Invalid: {error}", file=sys.stderr)
            sys.exit(1)
        try:
            with open(ACTION_FILE, "w") as f:
                json.dump(payload, f)
            print(f"Wrote action.json: sit seat={seat} stack={stack}")
        except Exception as e:
            print(f"Failed: {e}", file=sys.stderr)
            sys.exit(1)
        time.sleep(2.0)
        if not os.path.exists(ACTION_FILE):
            print("  Seat request sent")
        else:
            print("  (action.json still exists — bridge/orchestrator may not be running!)")
        sys.exit(0)

    # --leave: leave seat
    if "--leave" in args:
        ok = send_action("leave_seat")
        sys.exit(0 if ok else 1)

    # --sit-back: return to seat
    if "--sit-back" in args:
        ok = send_action("sit_back")
        sys.exit(0 if ok else 1)

    # --host <action>: host commands (start/stop/pause/resume/next)
    if "--host" in args:
        idx = args.index("--host")
        if idx + 1 >= len(args):
            print("Usage: --host <start|stop|pause|resume|next>")
            sys.exit(1)
        host_action = args[idx + 1]
        ok = send_host_action(host_action)
        sys.exit(0 if ok else 1)

    # --chat "message": send a chat message
    if "--chat" in args:
        idx = args.index("--chat")
        if idx + 1 >= len(args):
            print("Usage: --chat \"your message\"")
            sys.exit(1)
        message = args[idx + 1]
        ok = send_chat(message)
        sys.exit(0 if ok else 1)

    # --act: send an action
    if "--act" in args:
        idx = args.index("--act")
        if idx + 1 >= len(args):
            print("Usage: --act <fold|check|call|raise> [amount]")
            sys.exit(1)
        action = args[idx + 1]
        amount = int(args[idx + 2]) if idx + 2 < len(args) and args[idx + 2].isdigit() else None
        ok = send_action(action, amount)
        sys.exit(0 if ok else 1)

    # Default: fetch status and display
    ctx = get_status()

    if not ctx:
        print("No game state available.")
        print("Is bridge-live.js or orchestrator.js running?")
        print("  Single bot:  node scripts/bridge-live.js")
        print("  Multi bot:   node scripts/orchestrator.js")
        sys.exit(1)

    source = ctx.pop("_source", "unknown")
    print(format_hand(ctx))
    print(f"\n(source: {source})")

    # --auto: auto-play with heuristic
    if "--auto" in args and ctx.get("isMyTurn"):
        action, amount = heuristic_decide(ctx)
        print(f"\nHeuristic: {action}{f' ${amount}' if amount else ''}")
        send_action(action, amount)
    elif ctx.get("isMyTurn"):
        action, amount = heuristic_decide(ctx)
        print(f"\nHeuristic suggests: {action}{f' ${amount}' if amount else ''}")
        print("Send with: python decide.py --act <action> [amount]")


if __name__ == "__main__":
    main()
