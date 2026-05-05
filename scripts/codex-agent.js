#!/usr/bin/env node
/**
 * PokerBot Codex turn adapter.
 *
 * Maps stable PokerBot logical session keys such as `coachbot-Enyan` or
 * `pokerbot-Shark_Alice` onto Codex thread ids in `.stuclaw/sessions.json`.
 * The default stream backend uses StuClaw's Codex app-server adapter, which
 * preserves Codex-native agent message deltas without patching `codex exec`.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SESSION_DIR = path.join(PROJECT_ROOT, '.stuclaw');
const SESSION_DB = path.join(SESSION_DIR, 'sessions.json');
const INTERNAL_THREAD_DB = path.join(SESSION_DIR, 'internal-threads.json');
const INTERNAL_CODEX_HOME = path.join(SESSION_DIR, 'codex-home');
const CODEX_EVENTS_DIR = path.join(PROJECT_ROOT, 'game-data', 'codex-events');
const RECORD_CODEX_EVENTS = process.env.STUCLAW_RECORD_CODEX_EVENTS === '1';

function readPathsEnv() {
  const envPath = path.join(PROJECT_ROOT, 'paths.env');
  const pins = {};
  if (!fs.existsSync(envPath)) return pins;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)=(.*?)\s*$/);
    if (!m) continue;
    pins[m[1]] = m[2].replace(/^["']|["']$/g, '').replace('$HOME', process.env.HOME || '');
  }
  return pins;
}

function readSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_DB, 'utf8'));
  } catch {
    return {};
  }
}

function writeSessions(sessions) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(SESSION_DB, JSON.stringify(sessions, null, 2) + '\n');
}

function sourceCodexHome() {
  return path.resolve(
    process.env.STUCLAW_PARENT_CODEX_HOME
      || process.env.CODEX_HOME
      || path.join(process.env.HOME || '', '.codex'),
  );
}

function expandHome(value) {
  return String(value || '').replace(/\$HOME\b/g, process.env.HOME || '');
}

function linkSharedCodexFile(sourceHome, targetHome, name) {
  const source = path.join(sourceHome, name);
  const target = path.join(targetHome, name);
  if (!fs.existsSync(source)) return;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      const current = path.resolve(path.dirname(target), fs.readlinkSync(target));
      if (current === source) return;
      fs.unlinkSync(target);
    } else {
      return;
    }
  } catch {}

  try {
    fs.symlinkSync(source, target);
  } catch {
    try { fs.copyFileSync(source, target); } catch {}
  }
}

function prepareInternalCodexHome(pins) {
  const configured = process.env.STUCLAW_INTERNAL_CODEX_HOME || pins.STUCLAW_INTERNAL_CODEX_HOME || INTERNAL_CODEX_HOME;
  const targetHome = path.resolve(expandHome(configured));
  const parentHome = sourceCodexHome();
  fs.mkdirSync(targetHome, { recursive: true });
  fs.mkdirSync(path.join(targetHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(targetHome, 'archived_sessions'), { recursive: true });

  if (parentHome !== targetHome) {
    for (const name of ['auth.json', 'config.toml', 'models_cache.json', 'installation_id', 'AGENTS.md']) {
      linkSharedCodexFile(parentHome, targetHome, name);
    }
  }

  return targetHome;
}

function readInternalThreads() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INTERNAL_THREAD_DB, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.threads && typeof parsed.threads === 'object') return parsed;
    if (parsed && typeof parsed === 'object') return { version: 1, threads: parsed };
  } catch {}
  return { version: 1, threads: {} };
}

function rememberInternalThread(sessionKey, threadId) {
  if (!sessionKey || !threadId) return;
  const registry = readInternalThreads();
  registry.threads[threadId] = {
    app: 'pokerbot',
    scope: 'app-internal',
    sessionKey,
    threadId,
    cwd: PROJECT_ROOT,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(INTERNAL_THREAD_DB, JSON.stringify(registry, null, 2) + '\n');
}

function safeFilePart(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120) || 'unknown';
}

function appendCodexEvent(sessionKey, event) {
  if (!RECORD_CODEX_EVENTS) return;
  if (!event || typeof event !== 'object') return;
  const file = path.join(CODEX_EVENTS_DIR, `${safeFilePart(sessionKey)}.jsonl`);
  const record = {
    recorded_at: new Date().toISOString(),
    stream_schema: 'stuclaw.codex-stream.v1',
    sessionKey,
    ...event,
  };
  try {
    fs.mkdirSync(CODEX_EVENTS_DIR, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  } catch {
    // Event history is diagnostic. Never let it affect gameplay.
  }
}

function resolveCodexBin(pins) {
  const candidates = [
    process.env.CODEX_BIN,
    pins.CODEX_BIN,
    'codex',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes('/') && !fs.existsSync(candidate)) continue;
    return candidate;
  }
  return 'codex';
}

function resolveFromProject(specifier) {
  try {
    return require.resolve(specifier, { paths: [PROJECT_ROOT] });
  } catch {
    return '';
  }
}

function normalizeCandidate(candidate) {
  if (!candidate) return '';
  return path.isAbsolute(candidate) ? candidate : path.resolve(PROJECT_ROOT, candidate);
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function ancestorDirs(start, limit = 4) {
  const dirs = [];
  let dir = path.resolve(start);
  while (dirs.length < limit) {
    dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function shouldSkipSearchDir(name) {
  return new Set([
    '.git',
    '.stuclaw',
    'node_modules',
    'game-data',
    'uploads',
    'dist',
    'build',
    'target',
    '__pycache__',
  ]).has(name);
}

function findNearbyStreamScript() {
  const wanted = new Set(['codex-app-stream.cjs', 'codex-app-stream.js']);
  const roots = unique(ancestorDirs(PROJECT_ROOT, 4));
  const maxDepth = 4;
  const maxVisited = 8000;

  for (const root of roots) {
    let visited = 0;
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length && visited < maxVisited) {
      const { dir, depth } = stack.pop();
      visited += 1;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && wanted.has(entry.name)) return full;
        if (entry.isDirectory() && depth < maxDepth && !shouldSkipSearchDir(entry.name)) {
          stack.push({ dir: full, depth: depth + 1 });
        }
      }
    }
  }
  return '';
}

function resolveStuClawAppStreamScript(pins) {
  const candidates = [
    process.env.STUCLAW_STREAM_SCRIPT,
    pins.STUCLAW_STREAM_SCRIPT,
    resolveFromProject('@stuclaw/sdk/bin/codex-app-stream.js'),
    findNearbyStreamScript(),
  ].map(normalizeCandidate).filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function archiveThread(threadId, pins, childEnv) {
  if (!threadId) return;
  const script = resolveStuClawAppStreamScript(pins);
  if (!script || !fs.existsSync(script)) return;
  spawnSync(process.execPath || 'node', [
    script,
    '--json',
    '--cd',
    PROJECT_ROOT,
    '--archive-thread',
    threadId,
  ], {
    cwd: PROJECT_ROOT,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 30000,
  });
}

function mapModel(model) {
  if (!model) return process.env.CODEX_DEFAULT_MODEL || 'gpt-5.4';
  const modelKey = model.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const direct = process.env[`CODEX_MODEL_${modelKey}`];
  if (direct) return direct;
  if (/^(sonnet|opus|haiku)(-|$)/i.test(model)) {
    return process.env.CODEX_DEFAULT_MODEL || 'gpt-5.4';
  }
  return model;
}

function parseArgs(argv) {
  const cfg = {
    sessionKey: '',
    resume: false,
    reset: false,
    json: false,
    model: '',
    timeoutMs: 180000,
    promptParts: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      cfg.promptParts.push(...argv.slice(i + 1));
      break;
    } else if (arg === '--session-key' && argv[i + 1]) {
      cfg.sessionKey = argv[++i];
    } else if (arg === '--resume') {
      cfg.resume = true;
    } else if (arg === '--reset') {
      cfg.reset = true;
    } else if (arg === '--json') {
      cfg.json = true;
    } else if (arg === '--model' && argv[i + 1]) {
      cfg.model = argv[++i];
    } else if (arg === '--timeout-ms' && argv[i + 1]) {
      cfg.timeoutMs = Number(argv[++i]) || cfg.timeoutMs;
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      cfg.promptParts.push(arg);
    }
  }
  return cfg;
}

function printHelp() {
  console.log(`Usage: node scripts/codex-agent.js --session-key KEY [--resume] [--json] [--model MODEL] PROMPT

Options:
  --session-key KEY   Stable PokerBot logical session key.
  --resume           Resume the mapped Codex thread if it exists.
  --reset            Remove the key from .stuclaw/sessions.json and exit.
  --json             Forward backend JSONL events to stdout.
  --model MODEL      Codex model override.
  --timeout-ms N     Kill the subprocess after N milliseconds.`);
}

function promptFrom(cfg) {
  if (cfg.promptParts.length) return cfg.promptParts.join(' ');
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (!cfg.sessionKey) {
    console.error('codex-agent: --session-key is required');
    process.exit(2);
  }

  const sessions = readSessions();
  const pins = readPathsEnv();
  const internalCodexHome = prepareInternalCodexHome(pins);
  const childEnv = {
    ...process.env,
    CODEX_HOME: internalCodexHome,
    STUCLAW_PARENT_CODEX_HOME: sourceCodexHome(),
    PATH: process.env.PATH || '',
  };
  const knownThreadId = sessions[cfg.sessionKey];
  if (cfg.reset) {
    if (knownThreadId) {
      rememberInternalThread(cfg.sessionKey, knownThreadId);
      archiveThread(knownThreadId, pins, childEnv);
    }
    delete sessions[cfg.sessionKey];
    writeSessions(sessions);
    return;
  }

  const prompt = promptFrom(cfg);
  if (!prompt.trim()) {
    console.error('codex-agent: prompt is required');
    process.exit(2);
  }

  const backend = (process.env.STUCLAW_STREAM_BACKEND || pins.STUCLAW_STREAM_BACKEND || 'app-server').toLowerCase();
  const bin = backend === 'app-server' ? (process.execPath || 'node') : resolveCodexBin(pins);
  const model = mapModel(cfg.model);

  let args;
  if (backend === 'app-server') {
    const streamScript = resolveStuClawAppStreamScript(pins);
    if (!streamScript) {
      console.error('codex-agent: could not find StuClaw codex-app-stream adapter; set STUCLAW_STREAM_SCRIPT to the adapter file for this machine');
      process.exit(1);
    }
    args = [
      streamScript,
      '--json',
      '--cd',
      PROJECT_ROOT,
      '--timeout-ms',
      String(cfg.timeoutMs),
      '--approval-mode',
      'auto-deny',
      '--approval-policy',
      'on-request',
      '--sandbox',
      'read-only',
    ];
    if (model) args.push('--model', model);
    if (cfg.resume && knownThreadId) args.push('--resume', knownThreadId);
    args.push(prompt);
  } else {
    args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--cd',
      PROJECT_ROOT,
    ];
    if (model) args.push('--model', model);
    if (cfg.resume && knownThreadId) {
      args.push('resume', knownThreadId, prompt);
    } else {
      args.push(prompt);
    }
  }

  let finalMessage = '';
  let threadId = '';
  let stderr = '';
  let lineBuf = '';

  const child = spawn(bin, args, {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });

  const killer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
  }, cfg.timeoutMs);

  child.stdout.on('data', chunk => {
    lineBuf += chunk.toString();
    let idx;
    while ((idx = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      appendCodexEvent(cfg.sessionKey, evt);
      if (evt.type === 'thread.started' && evt.thread_id) {
        threadId = evt.thread_id;
        sessions[cfg.sessionKey] = threadId;
        rememberInternalThread(cfg.sessionKey, threadId);
      }
      if (evt.type === 'item.completed'
          && evt.item
          && evt.item.type === 'agent_message'
          && typeof evt.item.text === 'string') {
        finalMessage = evt.item.text;
      }
      if (cfg.json) process.stdout.write(JSON.stringify(evt) + '\n');
    }
  });

  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('error', err => {
    clearTimeout(killer);
    console.error(err.message);
    process.exit(1);
  });
  child.on('close', code => {
    clearTimeout(killer);
    if (threadId) {
      rememberInternalThread(cfg.sessionKey, threadId);
      writeSessions(sessions);
    }
    if (!cfg.json && finalMessage) process.stdout.write(finalMessage.trim() + '\n');
    if (code !== 0 && stderr.trim()) process.stderr.write(stderr);
    process.exit(code || 0);
  });
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
