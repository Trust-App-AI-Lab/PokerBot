# Requirements

- **Python 3.12+** with **numpy**
- **Node.js 20+** (npm included)
- **claude CLI** — <https://docs.claude.com/en/docs/claude-code>

Platform notes:
- Apple Silicon (arm64 Mac): install **native arm64** Python and Node. Don't use an Intel Homebrew at `/usr/local/bin/brew` — it produces x86_64 binaries that crash numpy under Rosetta.
- Install method is up to you (conda / uv / system package manager / brew). The project doesn't care as long as the three above are on PATH.

Then:
```bash
cd .claude/skills/poker-server && npm install
bash .claude/skills/game/start-game.sh --name YourName
```

Verify setup worked:
```bash
python3 -c "import numpy" && node --version && claude --version
python3 .claude/skills/poker-strategy/tools/equity.py 7h 7s "AA,KK,QQ"  # should print equity %
```
