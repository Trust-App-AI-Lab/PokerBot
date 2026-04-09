# CoachBot — Live Game Loop

Applies to ALL online modes (poker-server / remote / pokernow). CoachBot is the user's **sole interface** — all actions go through CC chat.

## Two Default Outputs

| Output | Default | What it does |
|--------|---------|-------------|
| **文字直播** (text narration) | **Always ON** | CoachBot polls state, summarizes game events in CC chat, gives GTO coaching. This is CoachBot's core — cannot be turned off. |
| **Preview 可视化** (browser table) | ON | poker-table.html shows visual table via poker-client.js relay on :3456. User says "关掉预览" / "no preview" → OFF, "打开预览" / "open preview" → ON. |

**Two runtime configurations:**
- **Preview ON** (default): Visual table in browser + text narration in CC chat. Best experience.
- **Preview OFF**: No relay server, no browser. CoachBot gives richer text descriptions (board layout + all stacks + positions). Lightest resource usage.

**Toggle implementation:**
- State tracked in conversation context: `previewEnabled = true/false`
- When Preview toggled OFF → CC stops poker-client.js relay. CC polls upstream directly (e.g. `localhost:3457/state?player=Name`).
- When Preview toggled ON → CC starts poker-client.js relay, user opens :3456 in browser.
- Toggle persists within session, resets to ON on next session.

## Mode Compatibility

All three online modes use the **same polling + narration loop** — only the upstream connection differs:

| Mode | Upstream | Relay | Text | Preview |
|------|----------|-------|------|---------|
| Mode 1 (Host) | `ws://localhost:3457` | poker-client.js | ✅ | ✅ :3456 |
| Mode 2 (Join) | `ws://friend:3457` | poker-client.js | ✅ | ✅ :3456 |
| Mode 3 (PokerNow) | pokernow WebSocket | coach-ws.js | ✅ | ✅ :3456 |
| Mode 4 (Text) | N/A (in-context) | none | ✅ built-in | ❌ N/A |

CC always polls `localhost:3456/state` regardless of mode. The relay handles upstream differences.

## State Display (文字直播)

CoachBot does NOT render ASCII tables. Concise text descriptions at key moments:

**Opponent actions** (brief):
```
🃏 CoachBot: Alice raises to $120 | Bob calls $120
```

**Key moments** (flop/turn/river dealt, your turn):
```
🃏 CoachBot: Flop: K♠ 7♥ 2♦ | Pot $240 | 你的手牌 A♠K♦
Alice raises to $120, Bob folds.
轮到你了 — call $120 / raise / fold？
```

**Hand result** (always shown):
```
🃏 CoachBot: Hand #12 结束 — Alice wins $480 (Two Pair)
筹码: You $850 | Alice $1320 | Bob $830
```

## Action → Poll → Render Loop

```
1. User says action (e.g. "call") or confirms CoachBot's advice
2. CoachBot executes: curl -s -X POST localhost:3456/action -d '{"action":"call"}'
   (if preview OFF, POST directly to upstream e.g. localhost:3457/action)
3. Polling loop:
   while not my turn and hand not over:
     sleep 2
     state = curl -s localhost:3456/state  (or upstream if preview OFF)
     if state changed → narrate opponent actions in CC chat
     (if preview ON, browser auto-updates via WebSocket)
4. isMyTurn == true → stop polling, show state + GTO analysis + advice
5. Wait for user input → back to step 1
```

## Polling Rules

**手动模式**（用户在线，逐手确认）：
- CC 内部 polling loop: 执行 action 后，每 2-3s `curl localhost:3456/state`，直到轮到用户或手牌结束
- 轮到用户时暂停，展示 GTO 分析，等用户决策
- 用户说话时响应用户，不阻塞对话

**自动模式**（用户离线，CoachBot 全权代打）：
- 同样用 polling loop，但 CoachBot 自动替用户做决策（用 GTO 工具分析后执行）
- 以解说员风格播报每手牌：场上情况、推理过程、决策结果
- 用户回来后可以看对话记录里的完整决策过程
- 用户随时可以说 "停" / "stop" 退出自动模式