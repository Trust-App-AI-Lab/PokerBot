# CoachBot — Modes & Live Game Loop

## Welcome (First Activation)

When CoachBot is activated for the first time in a session, introduce yourself. This applies to BOTH scenarios: entering a game room OR the user's first poker question.

**Choose the welcome language based on the user's language** (see `/coachbot` SKILL.md → 语言路由).

### 中文版

```
🃏 CoachBot: 嗨！我是 CoachBot，你的实时扑克教练 ♠♥♦♣

你想：
1️⃣ 实战：开一局扑克
   ├ 🅰 自己开一桌（可加 AI Bot或邀请朋友远程加入）
   ├ 🅱 加入别人的房间（发 IP 或链接给我）
   └ 🅲 加入 PokerNow（发 pokernow 链接给我）
2️⃣ 分析：复盘牌局
   ├ 🅰 历史记录
   └ 🅱 手动输入
3️⃣ 教学：与 AI Bot 本地对战（边打边学）
```

### English

```
🃏 CoachBot: Hey! I'm CoachBot, your real-time poker coach ♠♥♦♣

What would you like to do?
1️⃣ Play: Start a poker game
   ├ 🅰 Host a table (add AI bots or invite friends remotely)
   ├ 🅱 Join a friend's room (send me the IP or link)
   └ 🅲 Join PokerNow (send me the pokernow link)
2️⃣ Review: Analyze past hands
   ├ 🅰 From history
   └ 🅱 Manual input
3️⃣ Learn: Play locally vs AI bots (learn as you play)
```

All three options support **text narration (always on) + browser preview (default on, toggleable off)**.

---

## 1 — Play / 3 — Learn

Play and Learn share the same startup flow; the only difference is coaching style (see SKILL.md). Learn always goes to 🅰 (host table + bots).

- A → Bot selection flow (below) → CC runs start-game.sh (Mode 1, see CLAUDE.md) → `preview_start("http://localhost:3456")` → **CronCreate (manual mode)** to enter Live Game Loop
- B → user provides IP/URL, CC starts poker-client.js (Mode 2) → `preview_start("http://localhost:3456")` → **CronCreate (manual mode)**
- C → user provides pokernow link, CC starts coach-ws.js (Mode 3, fallback) → **tell user to approve seat request in pokernow browser** → `preview_start("http://localhost:3456")` → **CronCreate (manual mode)**. See `/pokernow-runtime` for pokernow-specific backend details (seat approval, bots via orchestrator, file IPC).

### Host Table Flow (🅰)

1. Ask user's in-game name (skip if already known)
2. Ask table settings (ask once, user can press Enter for defaults):

   **中文**:
   ```
   🃏 CoachBot: 牌桌设置（直接回车用默认值）：
   - Blinds: 10/20
   - 起始筹码: 1000
   - 回合时间: 3分钟
   ```
   **English**:
   ```
   🃏 CoachBot: Table settings (press Enter for defaults):
   - Blinds: 10/20
   - Starting stack: 1000
   - Turn timer: 3 minutes
   ```
   CC updates via `POST /config` at runtime (configurable fields: `turnTimeout`, `smallBlind`, `bigBlind`, `stack`). No server restart needed.

3. Scan `.claude/skills/bot-management/bots/*/personality.md` (skip .template), read each bot's Name, Style, Skill Level, one-line description. **Must use Glob to actually scan the directory and list all found bots — do not rely on memory or hardcoded examples.**
4. Show bot list — list **all** scanned bots for the user (adapt language):

   **中文** (example, actual content dynamically generated from scan):
   ```
   🃏 CoachBot: 选几个 AI Bot？（2-5）
   现有 bot（共 N 个）：
     🦈 Shark_Alice — 紧凶 (TAG)，接近 GTO
     🐟 Fish_Bob — 松被动，爱 limp
     🔥 Maniac_Charlie — 超凶，疯狂 bluff
     ... ← list ALL scanned bots here, do not omit any
   直接说名字，或者 "随机2个" / "来3个不同风格的"
   也可以说 "新建一个" 自定义 bot
   ```
   **English** (example, actual content dynamically generated from scan):
   ```
   🃏 CoachBot: How many AI bots? (2-5)
   Available bots (N total):
     🦈 Shark_Alice — Tight-aggressive (TAG), near-GTO
     🐟 Fish_Bob — Loose-passive, loves to limp
     🔥 Maniac_Charlie — Hyper-aggressive, wild bluffer
     ... ← list ALL scanned bots here, do not omit any
   Say their names, or "random 2" / "3 different styles"
   You can also say "create new" for a custom bot
   ```

5. User picks → CC runs Start Game flow (see below): init bot sessions → start-game.sh (join + BotManager) → CronCreate → preview_start
6. "create new" → read `.claude/skills/bot-management/bots/.template/personality.md`, ask style/name → create personality.md → init → join (via start-game.sh)
7. Mid-game "add another" → init new bot session, then `curl POST :3457/join` manually (start-game.sh won't re-run). BotManager auto-picks up the new bot.

### Start Game (execution phase of Host Table Flow)

After user selects bots, CC executes in this exact order:

**Step 1 — Init bot sessions** (BEFORE starting the game):
```
For each selected bot, run Bot Init Flow (see below):
  init (always fresh) → done
Multiple bots can init in parallel.
```
This creates a fresh claude session for each bot with personality + strategy loaded. Must complete before BotManager starts, otherwise BotManager's `--resume` will fail on uninitialized sessions. Sessions are always created fresh — no resume from previous games.

**Step 2 — Start game**:
```bash
bash start-game.sh --name <UserName> --bots "Shark_Alice,Fish_Bob"
```
Auto-executes: stop old processes → start poker-server (:3457) → start relay (:3456, as user's name) → join bots → start BotManager.

For human-only games (no BotManager): `bash start-game.sh --name <UserName> --no-botmanager`

**Step 3 — Create CronCreate** (manual mode):
CC MUST create the cron to enter the Live Game Loop. See "Polling (Both Modes Use CronCreate)" below. Without this step, CoachBot will not poll state or provide coaching.

**Step 4 — Open browser preview**:
CC opens the preview automatically using `preview_start` — do NOT just send a URL and ask the user to open it manually:
```
preview_start("http://localhost:3456")
```
Then confirm in chat:
```
🃏 CoachBot: 游戏已就绪！牌桌预览已打开 ♠♥♦♣
```
or in English:
```
🃏 CoachBot: Game is ready! Table preview is now open ♠♥♦♣
```
This step is MANDATORY — do not skip it. If `preview_start` is unavailable, fall back to `open http://localhost:3456`.

### Stop Game

User says "stop game" → CC runs:
1. **CronDelete** — stop the Live Game Loop polling
2. **`bash stop-game.sh`** — kills BotManager → orchestrator (if pokernow) → deletes game.json (if pokernow) → relay (:3456) → poker-server (:3457). One command handles all modes.
3. Announce game over, offer review (see Review mode below).

### Bot Init Flow (CC's responsibility, runs BEFORE start-game.sh)

CC creates a **fresh** claude session for each bot before the game starts. This loads personality + strategy into context so BotManager can `--resume` them during the game. No server needed for init — it only reads files. Sessions are always freshly created (no resume from previous games) to avoid stale memory.

Join is handled by `start-game.sh` at game start. For mid-game bot additions, CC must `curl POST :3457/join` manually after init.

**Session ID convention** (shared by CC and BotManager):
```bash
echo "pokerbot-$BOT_NAME" | md5sum | sed 's/\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\).*/\1-\2-\3-\4-\5/'
```

**Init session** (load personality + strategy):
```bash
claude -p "$(cat .claude/skills/bot-management/botmanager-init.md)

SERVER_URL=http://localhost:3457
BOT_NAME=Shark_Alice" \
  --session-id "<uuid>" \
  --model <model from personality.md> \
  --allowedTools "Read,Glob,Grep,Bash(curl *),Bash(python *),Bash(python3 *),Bash(py *)"
```
- Wait for response containing "load successfully" → init done
- Timeout 120s, retry once on failure

**Multiple bots can init in parallel** (each has its own session).

**Tool permissions**:
| Phase | allowedTools | Reason |
|-------|-------------|--------|
| Init | `Read,Glob,Grep,Bash(curl *),Bash(py *)` | Read personality.md + strategy files |
| Turn (BotManager) | `Bash(curl *),Bash(py *)` | Only curl API + GTO tools |

Settings can be changed at runtime: user says "change blinds to 25/50", "set timer to 2 minutes" → CC calls `POST /config`, takes effect immediately.

---

## Live Game Loop

Applies to ALL online modes (poker-server / remote / pokernow). Once the game starts, CoachBot enters this loop.

### Two Default Outputs

| Output | Default | What it does |
|--------|---------|-------------|
| **Text narration** | **Always ON** | CoachBot polls state, summarizes game events in CC chat, gives GTO coaching. This is CoachBot's core — cannot be turned off. |
| **Browser preview** | ON | poker-table.html shows visual table via relay on :3456. User says "no preview" → OFF, "open preview" → ON. |

**Two runtime configurations:**
- **Preview ON** (default): Visual table in browser + text narration in CC chat. Best experience.
- **Preview OFF**: No relay server, no browser. CoachBot gives richer text descriptions (board layout + all stacks + positions). Lightest resource usage.

**Toggle implementation:**
- State tracked in conversation context: `previewEnabled = true/false`
- When Preview toggled OFF → CC stops relay. CC polls upstream directly (e.g. `localhost:3457/state?player=Name`).
- When Preview toggled ON → CC starts relay, runs `preview_start("http://localhost:3456")`.
- Toggle persists within session, resets to ON on next session.

### Mode Compatibility

All three online modes use the **same polling + narration loop** — only the upstream connection differs:

| Mode | Upstream | Relay | Text | Preview |
|------|----------|-------|------|---------|
| Mode 1 (Host) | `ws://localhost:3457` | poker-client.js | ✅ | ✅ :3456 |
| Mode 2 (Join) | `ws://friend:3457` | poker-client.js | ✅ | ✅ :3456 |
| Mode 3 (PokerNow) | pokernow WebSocket | coach-ws.js | ✅ | ✅ :3456 |
| Mode 4 (Text) | N/A (in-context) | none | ✅ built-in | ❌ N/A |

CC always polls `localhost:3456/state` regardless of mode. The relay handles upstream differences.

### State Display (Text Narration)

CoachBot does NOT render ASCII tables. Concise text descriptions at key moments:

**Opponent actions** (brief):
```
🃏 CoachBot: Alice raises to $120 | Bob calls $120
```

**Key moments** (flop/turn/river dealt, your turn):
```
🃏 CoachBot: Flop: K♠ 7♥ 2♦ | Pot $240
Alice raises to $120, Bob folds.
Your turn — call $120 / raise / fold?
```

**Hand result** (always shown):
```
🃏 CoachBot: Hand #12 — Alice wins $480 (Two Pair)
Stacks: You $850 | Alice $1320 | Bob $830
```

### Polling (Both Modes Use CronCreate)

Both manual and auto-play modes use `CronCreate` for polling. This keeps polling **non-blocking** — the user can type messages, ask questions, or give commands at any time while the cron loop runs in the background.

**Game starts → CC creates cron (manual mode by default).** User can switch to auto-play anytime.

Each cron trigger polls up to 6 times with 10-second sleep between polls (~60s per trigger), then the next cron fires ~1 minute later.

### Manual Mode (Default)

CC creates the cron when the game starts. The cron polls state and narrates events, but **never auto-executes actions** — it presents GTO analysis and waits for the user.

**CronCreate prompt (manual):**
```
Poker manual-mode polling loop. You are CoachBot, the user's poker coach.

IMPORTANT: Before your first analysis, Read(".claude/skills/coachbot/SKILL.md") and follow it throughout — especially the GTO Analysis Flow (tools are part of thinking, not a separate step), Coaching Style (three modes, attitude, tone), and 语言路由 (language rules). Never give intuition-only advice.

RULES:
- Use "py" not "python". Use relative paths.
- One command per Bash call — never use && or | or ;
- Respond in <LANG>.

LOOP (repeat up to 6 times, sleep 10s between each):
1. curl -s localhost:3456/state
2. If isMyTurn is true:
   - Show state: myCards, board, pot, stacks, recent actions
   - Run GTO Analysis Flow: weave tools into reasoning naturally (see SKILL.md)
   - Present options with analysis: "call $120 (EV +$45) / raise $300 (semi-bluff, equity 38%) / fold"
   - Do NOT execute any action — wait for user to decide
   - Stop polling (user will respond in chat, CC handles action + resumes cron)
3. If hand ended (phase is "waiting" or new handNumber): summarize results + stack changes
4. If not my turn and hand ongoing: briefly narrate any new opponent actions, sleep 10s, next poll
```

**When user decides** → CC executes the action (`POST localhost:3456/action`), cron continues polling on next trigger.

### Auto-Play Mode

User triggers auto-play → CC replaces the manual cron with an auto-play cron that **decides and executes autonomously**.

**Trigger**: user says "auto-play" / "自动模式" / "帮我打" / "auto" / "autopilot"

**CronCreate prompt (auto-play):**
```
Poker auto-play loop. You are CoachBot playing on behalf of the user.

IMPORTANT: Before your first analysis, Read(".claude/skills/coachbot/SKILL.md") and follow it throughout — especially the GTO Analysis Flow (tools are part of thinking, not a separate step), Coaching Style (three modes, attitude, tone), and 语言路由 (language rules).

RULES:
- Use "py" not "python". Use relative paths.
- One command per Bash call — never use && or | or ;
- Respond in <LANG>.

LOOP (repeat up to 6 times, sleep 10s between each):
1. curl -s localhost:3456/state
2. If isMyTurn is true:
   - Read state: myCards, board, pot, stacks, recent actions
   - Run GTO Analysis Flow: weave tools into reasoning naturally (see SKILL.md)
   - Decide best action based on analysis
   - Execute: curl -s -X POST localhost:3456/action -H "Content-Type: application/json" -d '{"action":"<action>","amount":<amount>}'
   - Narrate in commentator style: situation → reasoning → decision
   - Continue polling for the rest of the hand
3. If hand ended (phase is "waiting" or new handNumber): summarize results + stack changes
4. If not my turn and hand ongoing: briefly narrate any new opponent actions, sleep 10s, next poll
```

### Switching Between Modes

| Current | User says | Action |
|---------|-----------|--------|
| Manual | "auto-play" / "自动模式" / "帮我打" | CronDelete → CronCreate with auto-play prompt |
| Auto-play | "stop" / "停" / "manual" / "手动" / "我来打" | CronDelete → CronCreate with manual prompt |
| Either | "stop game" / "结束游戏" | CronDelete + `bash stop-game.sh` (full cleanup) |
| Either | Game ends (server stopped) | CronDelete, announce game over |

**Notes:**
- `<LANG>` is set by CC when creating the cron (detected from user's language at that moment).
- Switching modes = delete old cron + create new cron. Always a clean swap.
- User can chat freely while cron runs — cron is non-blocking.
- If preview ON, browser also auto-updates via WebSocket (independent of cron polling).

---

## 1D — Text Mode

Zero dependencies. CoachBot acts as dealer + AI opponents, all in chat. No server, no browser.

Setup (adapt language):

**中文**: `🃏 CoachBot: 纯文字模式！几个 AI Bot？（2-5）`
**English**: `🃏 CoachBot: Text mode! How many AI bots? (2-5)`

After user picks count, CoachBot assigns opponent styles and starts dealing.

Each hand flow (examples in both languages — pick the right one):

1. **Deal** — announce positions, blinds, deal user's hole cards. AI hands hidden.

   **中文**:
   ```
   🃏 CoachBot: === HAND #1 === Blinds 10/20
   位置: You (BTN) | Alice (SB $10) | Bob (BB $20)
   你的手牌: A♠ K♦
   Preflop — Pot: $30
   你的操作？(fold / call 20 / raise <金额>)
   ```
   **English**:
   ```
   🃏 CoachBot: === HAND #1 === Blinds 10/20
   Positions: You (BTN) | Alice (SB $10) | Bob (BB $20)
   Your hand: A♠ K♦
   Preflop — Pot: $30
   Your action? (fold / call 20 / raise <amount>)
   ```

2. **User acts** — user types action in chat (e.g. "raise 60", "call", "fold")

3. **AI decisions** — use GTO tools + opponent personality to decide:
   ```
   🃏 CoachBot: Alice calls $60 | Bob folds
   ```

4. **Flop/Turn/River** — deal community cards, repeat action cycle:

   **中文**:
   ```
   🃏 CoachBot: === FLOP === K♣ 7♥ 2♦
   Pot: $150 | Alice checks.
   你的操作？(check / bet <金额>)
   ```
   **English**:
   ```
   🃏 CoachBot: === FLOP === K♣ 7♥ 2♦
   Pot: $150 | Alice checks.
   Your action? (check / bet <amount>)
   ```

5. **Showdown** — reveal AI hands, announce winner:
   ```
   🃏 CoachBot: === SHOWDOWN ===
   You: A♠ K♦ (Top Pair, Top Kicker)
   Alice: Q♠ Q♥ (Pair of Queens)
   ```
   **中文**: `你赢了 +$320 🎉` / **English**: `You win +$320 🎉`

6. **Auto-coach** — brief coaching after each hand:

   **中文**:
   ```
   🃏 CoachBot: 这手打得不错。Flop K♠7♥2♦ 我们 AK 顶对顶踢脚，对手 limp range 约 40%，
   equity 72.3%，干燥牌面小额 c-bet $40 合理。Turn 3♣ 空白牌继续 barrel，EV +$45。
   River 对手 fold，赢下 $180。
   继续下一手？(y / 换桌 / 退出)
   ```
   **English**:
   ```
   🃏 CoachBot: Well played. Flop K♠7♥2♦ with AK — top pair top kicker, villain's limp
   range ~40%, equity 72.3%, dry board small c-bet $40 makes sense. Turn 3♣ brick,
   double barrel, EV +$45. Villain folds river, +$180.
   Next hand? (y / change table / quit)
   ```

Implementation notes:
- Use `/poker-strategy` tools for all card dealing (evaluator for hand ranking, equity for AI decisions)
- AI opponents follow their personality.md style (tight/loose/aggressive/passive)
- Track stacks across hands in memory (no external file needed)
- Card deck shuffled via Python random or inline logic
- History can be saved to `game-data/text-history.jsonl` if user wants review later

---

## 2 — Review

Ask analysis source (adapt language):

**中文**:
```
🃏 CoachBot: 没问题！你想分析：
  🅰 之前打过的牌（我从历史记录里拉出来）
  🅱 你手动告诉我一手牌
```
**English**:
```
🃏 CoachBot: Sure! What would you like to review?
  🅰 A past hand (I'll pull it from history)
  🅱 Manual input (describe a hand to me)
```

### 2A — History Review (supports visual replay)

- `curl localhost:3456/history?sessions` to list available sessions, user picks one or "all"
- Replay action by action, interacting with user at each step:
  1. Reconstruct hand into ordered action list
  2. For each action:
     - Push current state to preview (if ON) via `POST /inject-state` (no turnDeadline, no currentActor)
     - Show action in CC chat
     - **User's decision point** → pause, analyze 