---
name: game
description: >
  PokerBot game entry point — start/stop a poker game, welcome flow, bot selection, mid-game bot/config management, text mode, hand review. Trigger when user wants to PLAY a game ("play poker", "开一局", "start game", "stop game", "join <IP>", pokernow URL). For pure analysis/coaching without a game, use /coachbot instead. For direct GTO tool calls, use /poker-strategy.
author: EnyanDai
version: 1.0.0
tags:
  - poker
  - game
  - lifecycle
  - entry-point
metadata:
  openclaw:
    requires:
      bins:
        - node
        - python3
        - claude
        - curl
---

# Game — Entry Point & Session Management

This skill is the **game entry point**: welcome flow, bot selection, start/stop, mid-game management, text mode, review.

**Who loads this**: CC (the main session orchestrator), on-demand when the user wants to play / control a game. The browser UI (served by the relay on :3456) owns the live play loop — action buttons, CoachBot panel, narrator commentary. CC's job is session management around it.

## What This SKILL Contains

- `SKILL.md` — this file (flows below)
- `start-game.sh` — full-stack launcher (server + relay + narrator + bots + BotManager + CoachBot pre-warm + opens browser). Also handles `stop` / `restart` subcommands.
- `stop-game.sh` — orchestrated shutdown: delegates to each component's stop script. (Invoked by `start-game.sh stop`; can also be called directly.)

## CC's Role

Once `start-game.sh` runs, the browser panel is self-sufficient for gameplay. CC stays useful for **session-level management**:

- Welcome + bot selection (pre-start)
- Mid-game add/remove bot (`POST :3457/join`)
- Config changes (`POST :3457/config` — blinds, stack, timer)
- Create custom bots from `.template/`
- Stop game, history review, text mode
- Pokernow setup (Mode 3)
- Debugging

CC does **not** run the per-turn coaching loop — the narrator daemon (:3460) pushes coaching into the browser panel via WebSocket. No polling, no CronCreate.

---

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

---

## 1 — Play / 3 — Learn

Play and Learn share the same startup flow; the only difference is coaching style (see `/coachbot` SKILL.md). Learn always goes to 🅰 (host table + bots).

- A → Bot selection flow (below) → CC runs `start-game.sh` → browser opens automatically → user clicks Fold/Call/Raise in the browser, narrator pushes coaching into the panel
- B → user provides IP/URL, CC runs `start-game.sh` pointed at the remote server (same browser panel)
- C → user provides pokernow link → see `.claude/skills/pokernow-runtime/ARCHITECTURE.md` (different bridge, same browser UX)

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

5. "create new" → read `.claude/skills/bot-management/bots/.template/personality.md`, ask style/name → create personality.md under `bots/<NewName>/` → continue to Start Game.

### Start Game

One command launches the whole stack (server, relay, narrator, bots, BotManager, CoachBot pre-warm, browser):

```bash
bash .claude/skills/game/start-game.sh --name <UserName> --bots "Shark_Alice,Fish_Bob"
```

Flags:
- `--auto` — narrator starts in auto-play mode (CoachBot decides for the user)
- `--lang zh|en` — narrator language (default `zh`; CC should pass the language matching the user)
- `--public` — expose server on 0.0.0.0 for LAN play
- `--no-open` — skip auto-opening the browser (rare — e.g. headless setups)
- `--no-botmanager` — human-only table
- `--no-coach` — skip CoachBot pre-warm (bot-vs-bot testing only)

After the script returns, the browser points at `http://localhost:3456` (opened automatically) and the server sits at `phase: waiting` with everyone seated. The host clicks the green **Start** button (top-right controls, host-only) to deal the first hand. CC can also `curl -s -X POST localhost:3457/start` if the user just says "go" / "开始" in chat.

The **Settings** panel (host-only) has an `autoStart` checkbox (default on): on → server auto-deals the next hand after each showdown; off → host clicks Start between hands. Same field is available via `POST /config` for CC.

### Mid-Game Operations (CC's main job once the game is running)

CC is the **session-level** manager — lifecycle + config, not per-hand actions. Per-hand actions (fold/call/raise) go through the browser: either the action buttons (direct WS to relay) or the CoachBot panel input box (user chats → subprocess CoachBot decides → relay parses `ACTION=…` sentinel on its reply and forwards upstream — see `/coachbot` → "Panel Action Routing"). CC never POSTs to `/action`.

| Intent | Trigger phrases | Command |
|---|---|---|
| Deal first hand (if user didn't click Start in browser) | "开始" / "go" / "deal" | `curl -s -X POST localhost:3457/start` |
| Add bot | "再加一个 bot" / "add X" | (create personality if new) → `curl -s -X POST localhost:3457/join -H 'Content-Type: application/json' -d '{"name":"<BotName>"}'` — BotManager picks it up automatically |
| Sit bot out | "踢了 X" / "remove X" | `curl -s -X POST localhost:3457/sit -H 'Content-Type: application/json' -d '{"player":"<Name>","sit":"out"}'` |
| Change blinds / stack / timer | "盲注改 25/50" / "set timer to 2 minutes" | `POST :3457/config` (takes effect next hand) |
| Toggle auto-deal between hands | "自动发牌关了" | `POST :3457/config {"autoStart": false}` (or toggle the Settings checkbox in browser) |
| Switch CoachBot to auto-play | "自动模式" / "帮我打" / "auto play" | `curl -s -X POST localhost:3460/mode -H 'Content-Type: application/json' -d '{"mode":"auto"}'` |
| Switch CoachBot back to manual | "我来打" / "manual" / "stop auto" | `curl -s -X POST localhost:3460/mode -H 'Content-Type: application/json' -d '{"mode":"manual"}'` |

**If the user says "fold" / "call" / "raise 200" in CC chat**: don't POST /action. Point them to the browser — either click the action buttons, or type the same command into the CoachBot panel (the subprocess CoachBot will confirm if ambiguous and emit the sentinel on explicit commands). CC is session-level; per-hand decisions live in the browser so the eyes-on-table UX stays coherent.

### Stop Game

User says "stop game" → CC runs:

```bash
bash .claude/skills/game/stop-game.sh
```

This kills BotManager → narrator → relay → server in order. Then announce game over, offer review (see Review section below).

### Session Lifecycle

`start-game.sh` owns the session lifecycle end-to-end. CC does **not** create claude sessions itself.

**Deterministic SIDs** (per bot name / per user name):
```bash
# Bot session
echo "pokerbot-$BOT_NAME" | md5 | sed 's/\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\).*/\1-\2-\3-\4-\5/'
# CoachBot session
echo "coachbot-$USER_NAME" | md5 | sed 's/\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\).*/\1-\2-\3-\4-\5/'
```
Same name → same SID. Same md5 scheme used everywhere (start-game.sh, botmanager.sh, CC).

**Wipe on game start** (`start-game.sh` deletes `~/.claude/projects/<enc>/<sid>.jsonl` + companion dir) — guarantees fresh claude-side conversation history for every new game. Game history (`history.jsonl`, `game-data/`) is untouched.

**CoachBot init** is done synchronously by start-game.sh. If it fails, the relay auto-initializes on the first `POST /coach-ask`. CC never needs to resume the session manually — coaching goes through `POST :3456/coach-ask`.

**Bot init** is on-demand, handled by BotManager when it first sees a bot's turn.

**CC's responsibility**: `curl` the game API for management ops, answer ad-hoc questions. Never create claude sessions, never pre-init bots.

**Tool permissions**: 当前阶段全部 `bypassPermissions`。

### Debugging

When the normal flow breaks and you need to inspect state inside Claude Code (desktop only):

```
preview_start("http://localhost:3456")   # embed the browser panel in CC
preview_stop(<serverId>)                 # (use preview_list to find the id)
```

This is **debug-only** — `start-game.sh` already opens a real browser tab. Use `preview_start` only when you need to read the DOM / logs from CC.

---

## Live Play (What's Actually Happening)

Once the browser is open, coaching is **event-driven**. No CC polling.

- Server (:3457) → broadcasts state diffs to relay.
- Relay (:3456) → pushes state to browser, serves the CoachBot panel, owns the serialized `claude -p --resume $COACH_SID` FIFO queue.
- Narrator (:3460) → subscribes to relay WS, detects `your_turn` / `hand_result` events, posts to `:3456/coach-ask` with a state summary; in `auto` mode, its prompt instructs the subprocess to put `ACTION=… AMOUNT=…` on the last line, and the **relay** strips/forwards the sentinel (narrator just checks `r.action` to confirm it landed).
- Browser panel → receives CoachBot replies via WS, user clicks action buttons.
- CC → free to handle management commands / chat questions.

### Ad-hoc coach questions from CC

```bash
curl -s -X POST localhost:3456/coach-ask -H "Content-Type: application/json" -d '{"question":"该不该call?"}'
```

Funneled through the same queue as narrator triggers.

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

### 2A — History Review

- `curl localhost:3456/history?sessions` to list available sessions, user picks one or "all"
- `curl localhost:3456/history?last=5` for recent hands
- Walk through action-by-action, pausing at user's decision points for analysis

## Dependencies

- `/coachbot` — the coach itself (persona, GTO analysis, language)
- `/bot-management` — bot init + BotManager process
- `/poker-strategy` — GTO tool library
- `.claude/skills/poker-server/` — server + relay + narrator (infrastructure folder, not a skill — see `ARCHITECTURE.md`)
- `.claude/skills/pokernow-runtime/` — pokernow.com adapter (Mode 3 only, not a skill — see `ARCHITECTURE.md`)
