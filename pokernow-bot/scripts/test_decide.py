#!/usr/bin/env python3
"""
Test suite for decide.py — validates all commands work correctly.
Requires bridge-live.js or orchestrator.js to be running for live tests.

Usage:
    python scripts/test_decide.py           # run all tests
    python scripts/test_decide.py --quick   # skip slow tests (chat/sit)
"""

import subprocess
import sys
import os
import json
import time

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
DECIDE_PY    = os.path.join(SCRIPT_DIR, "decide.py")
ENGINE_DIR   = os.path.join(SCRIPT_DIR, "..")
PROJECT_ROOT = os.path.join(ENGINE_DIR, "..")

# Find python executable
PY = "py" if os.name == "nt" else "python3"

# Bot name: default (matches decide.py default)
BOT_NAME = "ARIA_Bot"

# Files in bot_profiles/{BOT_NAME}/
PROFILE_DIR = os.path.join(PROJECT_ROOT, "bot_profiles", BOT_NAME)
ACTION_FILE = os.path.join(PROFILE_DIR, "action.json")
STATE_FILE  = os.path.join(PROFILE_DIR, "state.json")
TURN_FILE   = os.path.join(PROFILE_DIR, "turn.json")


passed = 0
failed = 0
skipped = 0


def run(args, expect_rc=0, timeout=10):
    """Run decide.py with args, return (returncode, stdout, stderr)."""
    cmd = [PY, DECIDE_PY] + args
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "TIMEOUT"


def test(name, args, expect_rc=0, expect_in_stdout=None, expect_in_stderr=None, expect_not_in_stdout=None, timeout=10):
    """Run a test case."""
    global passed, failed
    rc, stdout, stderr = run(args, timeout=timeout)

    errors = []
    if rc != expect_rc:
        errors.append(f"exit code: got {rc}, expected {expect_rc}")
    if expect_in_stdout and expect_in_stdout not in stdout:
        errors.append(f"stdout missing: '{expect_in_stdout}'")
    if expect_in_stderr and expect_in_stderr not in stderr:
        errors.append(f"stderr missing: '{expect_in_stderr}'")
    if expect_not_in_stdout and expect_not_in_stdout in stdout:
        errors.append(f"stdout should NOT contain: '{expect_not_in_stdout}'")

    if errors:
        failed += 1
        print(f"  FAIL  {name}")
        for e in errors:
            print(f"        {e}")
        if stdout.strip():
            print(f"        stdout: {stdout.strip()[:200]}")
        if stderr.strip():
            print(f"        stderr: {stderr.strip()[:200]}")
    else:
        passed += 1
        print(f"  OK    {name}")


def test_validation(name, action_payload, expect_error):
    """Test action validation by importing validate_action directly."""
    global passed, failed
    sys.path.insert(0, SCRIPT_DIR)
    try:
        from decide import validate_action
        err = validate_action(action_payload)
        if expect_error:
            if err is None:
                failed += 1
                print(f"  FAIL  {name} — expected error but got None")
                return
            if expect_error not in err:
                failed += 1
                print(f"  FAIL  {name} — expected '{expect_error}' in '{err}'")
                return
        else:
            if err is not None:
                failed += 1
                print(f"  FAIL  {name} — expected valid but got: {err}")
                return
        passed += 1
        print(f"  OK    {name}")
    except Exception as e:
        failed += 1
        print(f"  FAIL  {name} — exception: {e}")


def check_bridge_running():
    """Check if bridge-live.js or orchestrator is running by looking for state/turn file."""
    if os.path.exists(TURN_FILE) or os.path.exists(STATE_FILE):
        return True
    print(f"  WARNING: no state/turn file in {PROFILE_DIR}, bridge may not be running")
    return False


def main():
    global passed, failed, skipped
    quick = "--quick" in sys.argv

    print(f"\nTesting decide.py (BOT_NAME={BOT_NAME})")
    print(f"Profile dir: {PROFILE_DIR}")
    print(f"{'='*60}")

    bridge_up = check_bridge_running()

    # ── Validation tests (no bridge needed) ──────────
    print("\n--- Validation Tests ---")

    test_validation("valid fold",       {"action": "fold"}, None)
    test_validation("valid check",      {"action": "check"}, None)
    test_validation("valid call",       {"action": "call"}, None)
    test_validation("valid raise",      {"action": "raise", "amount": 200}, None)
    test_validation("valid bet",        {"action": "bet", "amount": 100}, None)
    test_validation("valid chat",       {"action": "chat", "message": "hi"}, None)
    test_validation("valid sit",        {"action": "sit"}, None)
    test_validation("valid sit+seat",   {"action": "sit", "seat": 5, "stack": 1000}, None)
    test_validation("valid leave",      {"action": "leave_seat"}, None)
    test_validation("valid sit_back",   {"action": "sit_back"}, None)
    test_validation("valid start_game", {"action": "start_game"}, None)
    test_validation("valid approve",    {"action": "approve_player", "player_id": "abc"}, None)
    test_validation("valid remove",     {"action": "remove_player", "player_id": "abc"}, None)

    test_validation("missing action",   {"amount": 100}, "Missing 'action'")
    test_validation("empty action",     {"action": ""}, "Missing 'action'")
    test_validation("unknown action",   {"action": "bluff"}, "Unknown action")
    test_validation("raise no amount",  {"action": "raise"}, "requires 'amount'")
    test_validation("raise zero",       {"action": "raise", "amount": 0}, "positive amount")
    test_validation("raise negative",   {"action": "raise", "amount": -50}, "positive amount")
    test_validation("bet no amount",    {"action": "bet"}, "requires 'amount'")
    test_validation("chat no message",  {"action": "chat"}, "requires 'message'")
    test_validation("chat empty msg",   {"action": "chat", "message": ""}, "requires 'message'")
    test_validation("approve no pid",   {"action": "approve_player"}, "requires 'player_id'")
    test_validation("remove no pid",    {"action": "remove_player"}, "requires 'player_id'")
    test_validation("not a dict",       "fold", "must be a dict")

    # ── CLI tests ────────────────────────────────────
    print("\n--- CLI Tests ---")

    # History
    test("history", ["--history", "3"], expect_rc=0)

    # Invalid action via CLI
    test("act missing arg", ["--act"], expect_rc=1, expect_in_stdout="Usage:")

    # Read state (may fail if bridge not running, that's OK)
    if bridge_up:
        test("read state (default)", [], expect_rc=0, expect_in_stdout="Phase:")

    if quick:
        print("\n--- Skipping slow tests (--quick mode) ---")
        skipped += 4
    elif bridge_up:
        print("\n--- Live Tests (bridge required) ---")

        # Chat
        test("chat", ["--chat", "test from test suite"], expect_rc=0,
             expect_in_stdout="Chat sent", timeout=10)

        # Fold (may fail if not in a hand, but should at least write+execute)
        test("act fold", ["--act", "fold"], expect_rc=0,
             expect_in_stdout="action.json", timeout=10)

        # Check
        test("act check", ["--act", "check"], expect_rc=0,
             expect_in_stdout="action.json", timeout=10)

        # Raise with amount
        test("act raise 200", ["--act", "raise", "200"], expect_rc=0,
             expect_in_stdout="action.json", timeout=10)
    else:
        print("\n--- Skipping live tests (bridge not running) ---")
        skipped += 4

    # ── Summary ──────────────────────────────────────
    total = passed + failed + skipped
    print(f"\n{'='*60}")
    print(f"Results: {passed} passed, {failed} failed, {skipped} skipped / {total} total")
    if failed:
        print("SOME TESTS FAILED")
        sys.exit(1)
    else:
        print("ALL TESTS PASSED")
        sys.exit(0)


if __name__ == "__main__":
    main()
