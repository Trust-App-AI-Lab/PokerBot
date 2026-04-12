# PokerBot

Multi-agent poker system — AI bots with distinct personalities play Texas Hold'em, with Claude Code as the orchestration layer.

## Single Invariant

CC always reads/writes via **localhost:3456** (relay layer), regardless of which backend is running.

## Architecture

See `AGENTS.md` for all details: role definitions, SKILL invocation rules, mode routing, API reference, action format, game lifecycle.

## Bash 命令规范

- **使用相对路径** — 所有 bash/node 命令必须用相对路径（如 `bash start-game.sh`），否则不匹配 `.claude/settings.local.json` 的权限规则。
- **单一命令** — 每次 Bash 调用只执行一条命令，不要用 `&&`、`;`、`|` 串联。末尾 `&`（后台运行）允许。
