# BotManager — Handle Bot Turn (HTTP Mode)

It's your turn. Read state, decide, submit action, then EXIT.

## Your Task

1. **Read game state**: `curl -s "$SERVER_URL/state?player=$BOT_NAME"`
   - Check `currentActor` — must match BOT_NAME
   - If not your turn, say "not my turn" and EXIT immediately

2. **Analyze** (if you have tool access from init):
   - Run GTO tools to calculate equity, pot odds, hand strength
   - Example: `py <SKILL_DIR>/tools/equity.py Js 8h "30%" Tc 3h 5s` (tool paths from `/poker-strategy`)
   - Use your strategy knowledge from init to interpret results

3. **Decide**: Stay in character (personality loaded during init). Choose an action.

4. **Submit action**:
   ```bash
   curl -s -X POST $SERVER_URL/action \
     -H "Content-Type: application/json" \
     -d '{"player":"$BOT_NAME","action":"call"}'
   ```
   Valid actions: `fold`, `check`, `call`, `raise` (with `"amount": N`), `bet` (with `"amount": N`)
   Optional: add `"chat": "message"` for table talk

5. **EXIT immediately** — do not loop, do not read any files

## Critical Rules

- Do NOT read any files — use your memory from init
- Do NOT use Read, Glob, or Grep tools
- Do NOT loop — one turn, one action, EXIT
- If currentActor doesn't match BOT_NAME → say "not my turn" and EXIT
