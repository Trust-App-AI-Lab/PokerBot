# PokerBot — First Run Setup

CC reads this file on first run to set up the environment. Each step checks → asks user → installs if approved → records result.

## How This Works

1. CC reads this file when user first mentions poker / play / coaching
2. CC runs checks in order, asking user before each install
3. Results are saved to `setup-status.json` (auto-generated)
4. On subsequent sessions, CC reads `setup-status.json` to skip completed steps
5. If any dependency is missing, CC tells the user which features are available

## Setup Steps

### Step 0: Read setup-status.json

```python
# If exists, load it and skip completed steps
# If not, start fresh — this is the first run
try:
    Read("setup-status.json")
    # → Parse JSON, skip steps already marked "ok"
    # → Re-check steps marked "skip" or "fail" only if user asks
except:
    # First run — proceed with all steps
    pass
```

### Step 1: Node.js (Required — Runtime Engine)

**Check**: `node --version` → need 18+
**If missing**: Tell user to install Node.js 18+ from https://nodejs.org
**Cannot auto-install**: System-level dependency

Features blocked without Node.js: ALL live game features (WebSocket, orchestrator, coach-bridge, coach-server). Only offline coaching (hand analysis, GTO teaching) works.

### Step 2: Python (Required — GTO Tools)

**Check**: `python3 --version` or `python --version` → need 3.10+
**If missing**: Tell user to install Python 3.10+ from https://python.org
**Cannot auto-install**: System-level dependency

Features blocked without Python: ALL GTO calculations (equity, odds, preflop ranges, hand evaluation). Only text-based coaching (no numbers) works.

### Step 3: numpy (Required for Equity Calculator)

**Check**: `python3 -c "import numpy; print(numpy.__version__)"`
**Install command**: `pip install numpy` (or `pip install numpy --break-system-packages` if needed)
**Ask user**: "需要安装 numpy（equity 计算器依赖），可以吗？"

Features blocked without numpy: equity.py (Monte Carlo equity calculator). Other tools (odds, preflop, evaluator) still work.

### Step 4: npm dependencies (Required for Live Game)

**Check**: `ls pokernow-bot/node_modules/.package-lock.json` (exists = installed)
**Install command**: `cd pokernow-bot && npm install`
**Ask user**: "需要运行 npm install 安装 WebSocket 等依赖（ws, dotenv, node-fetch），可以吗？"

Packages installed: ws (WebSocket), dotenv (env config), node-fetch (HTTP client).

Features blocked without npm install: ALL live game connections.

### Step 5: .env Configuration

**Check**: `ls pokernow-bot/.env` (exists = configured)
**Action**: `cp pokernow-bot/.env.example pokernow-bot/.env`
**Ask user**: "需要从 .env.example 创建 .env 配置文件，可以吗？（GAME_URL 之后进房间时自动填写）"

Note: GAME_URL is set dynamically at game start by SKILL.md flow — user doesn't need to edit .env manually.

### Step 6: claude CLI (Optional — PlayBots)

**Check**: `claude --version`
**If missing**: Tell user this is needed for PlayBot autonomous decisions.
  - Install: https://docs.claude.ai/en/docs/claude-code
  - Or: PlayBots won't work, but CoachBot + manual play is fully functional.
**Cannot auto-install**: Separate tool

Features blocked without claude CLI: BotManager cannot spawn subagents → PlayBots cannot make autonomous decisions. CoachBot coaching works fine.

### Step 7: Claude in Chrome (Optional — Live CoachBot)

**Check**: Cannot auto-detect. Ask user:
  "你有安装 Claude in Chrome 浏览器扩展吗？（CoachBot 实时看牌需要它来注入 bridge）"
  - Yes → record as ok
  - No → tell user: CoachBot live game bridging won't work. Offline coaching and PlayBots still work.
  - Install: Chrome Web Store → "Claude in Chrome"
**Cannot auto-install**: Browser extension

Features blocked without Claude in Chrome: coach-bridge.js cannot be injected → CoachBot cannot read live game state. Offline coaching (你告诉我牌面我帮你分析) still works.

### Step 8: botmanager.sh Permissions

**Check**: `test -x pokernow-bot/scripts/botmanager.sh`
**Fix command**: `chmod +x pokernow-bot/scripts/botmanager.sh`
**Auto-fix**: Yes, no need to ask user (harmless operation).

### Step 9: Port 3456 Availability

**Check**: `curl -s http://localhost:3456/ 2>&1` → should fail (port free) or show coach-server response (already running)
**If occupied by another process**: Tell user port 3456 is in use, coach-server may fail to start.
**Auto-fix**: No — just report.

## Setup Status File Format

After running all steps, write `setup-status.json`:

```json
{
  "version": 1,
  "timestamp": "2026-04-07T12:00:00Z",
  "steps": {
    "node": { "status": "ok", "version": "22.1.0" },
    "python": { "status": "ok", "version": "3.12.0" },
    "numpy": { "status": "ok", "version": "1.26.0" },
    "npm_install": { "status": "ok" },
    "env_file": { "status": "ok" },
    "claude_cli": { "status": "skip", "reason": "User declined — PlayBots unavailable" },
    "chrome_extension": { "status": "ok" },
    "botmanager_chmod": { "status": "ok" },
    "port_3456": { "status": "ok" }
  },
  "available_features": {
    "offline_coaching": true,
    "live_coaching": true,
    "playbots": false,
    "full_system": false
  }
}
```

Status values: `"ok"` | `"skip"` (user declined) | `"fail"` (cannot install) | `"missing"` (not checked yet)

## Feature Availability Matrix

After setup, CC determines which features are available:

| Feature | Requires |
|---------|----------|
| **Offline Coaching** (手动输入牌面分析) | Python + numpy |
| **Live CoachBot** (实时读牌 + 建议) | Node.js + npm + Python + numpy + Chrome Extension |
| **PlayBots** (AI 自主决策) | Node.js + npm + Python + claude CLI |
| **Full System** (全部功能) | ALL of the above |

CC should tell the user at the end of setup:

```
✅ Setup complete! Available features:
  ✅ Offline Coaching — 告诉我牌面，我帮你 GTO 分析
  ✅ Live CoachBot — 实时读牌 + 建议
  ❌ PlayBots — 需要安装 claude CLI

Say "来一局poker" to start!
```

## Re-running Setup

User can say "重新检查环境" / "re-run setup" / "check dependencies" to re-run all checks. CC should:
1. Delete or ignore `setup-status.json`
2. Re-run all steps from Step 1
3. Write new `setup-status.json`

## Important Notes for CC

- **Always ask before installing**. Never silently run `pip install` or `npm install`.
- **Record everything** in setup-status.json so next session doesn't re-ask.
- **Be specific about what's blocked**. Don't just say "setup incomplete" — say exactly which features work and which don't.
- **Don't block on optional deps**. If Claude in Chrome or claude CLI is missing, proceed with available features.
- **.env GAME_URL is set later**. Don't ask user to manually edit .env — SKILL.md flow fills GAME_URL at game start.
