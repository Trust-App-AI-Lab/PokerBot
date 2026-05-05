---
name: game
description: >
  PokerBot game entry point for StuClaw Desktop. Use when the user wants to
  play, host or join a poker table, join PokerNow, review hands, learn with
  AI bots, change game mode, start, or stop PokerBot.
author: EnyanDai
version: 1.1.0
tags:
  - poker
  - game
  - lifecycle
metadata:
  openclaw:
    requires:
      bins:
        - node
        - python
        - codex
        - curl
---

# PokerBot Game

This skill is the user-facing router for PokerBot. Start from the welcome menu, then execute only the selected route.

## Welcome

Use the user's language. On a fresh game request, show this menu, then immediately scan `.agents/skills/bot-management/bots/*/personality.md` (skip `.template`) and append a compact "available AI bots" list before waiting for a choice. List all found bot names with their style/skill-level hints; do not rely on memory or hardcoded examples.

Chinese:

```text
🃏 CoachBot: 嗨！我是 CoachBot，你的实时扑克教练 ♠♥♦♣

你想：
1️⃣ 实战：开一局扑克
   ├ 🅰 自己开一桌（可加 AI Bot 或邀请朋友远程加入）
   ├ 🅱 加入别人的房间（发 IP 或链接给我）
   └ 🅲 加入 PokerNow（发 pokernow 链接给我）
2️⃣ 分析：复盘牌局
   ├ 🅰 历史记录
   └ 🅱 手动输入
3️⃣ 教学：与 AI Bot 本地对战（边打边学）
```

English:

```text
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

## Routes

### 1A. Host A Table

First scan `.agents/skills/bot-management/bots/*/personality.md` (skip `.template`) and show the available bot names/styles before asking the user to choose. Do not rely on memory or hardcoded examples.

Collect: player name, bot list or random/default bots, language, whether friends need a remote link, and whether table settings stay at defaults.

Run from the app root:

```bash
bash ./start.sh --name "<name>" --bots "<BotA,BotB>" --lang <zh|en> --no-open
```

Add `--public` only when the user wants friends to join remotely. Add `--auto` only when the user explicitly wants CoachBot to act for them.

After launch, tell the user to review Settings in the table UI, choose/sit in a seat if needed, then press the table's Start button to deal.

### 1B. Join A Friend's Room

Collect: player name and the friend's PokerBot IP/link. This route does not start a local server.

Start the local relay through the lifecycle script. It converts PokerBot URLs to the server WebSocket URL, spawns `poker-client.js` detached, writes `.relay.pid`, logs to `game-data/relay.log`, and runs a bounded readiness check so the foreground Codex turn does not hang.

```bash
bash .agents/skills/game/join-room.sh --url "<friend-url-or-ws-url>" --name "<name>" --no-open
```

If the readiness check fails, report `game-data/relay.log`; do not start `poker-client.js` in the foreground.

Use this only for PokerBot rooms. If the link is PokerNow, use route 1C.

### 1C. Join PokerNow

Collect: player name and the PokerNow URL.

Run from the app root:

```bash
bash .agents/skills/pokernow-runtime/start-pokernow.sh --url "<pokernow-url>" --name "<name>"
```

Treat PokerNow as a fallback adapter. Keep the user's action decisions in the PokerNow room UI unless they explicitly ask CoachBot to advise.

### 2A. Review From History

Do not start a new game. If the relay is running, read recent hands from history and summarize decision points. If no relay is running, use saved history under `game-data/<name>/history/` when available.

### 2B. Manual Review

Ask the user to paste or describe the hand. Route strategic analysis through `coachbot`; do not start PokerBot.

### 3. Learn

Collect: player name, bot list or default bots, language, and whether table settings stay at defaults.

Run the same local start route as 1A, without `--auto` unless explicitly requested. CoachBot should explain decisions more actively, but the player still acts through the table UI.

### Stop

When the user asks to stop PokerBot, run from the app root:

```bash
bash ./stop.sh
```
