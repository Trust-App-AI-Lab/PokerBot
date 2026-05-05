#!/usr/bin/env node
const fs = require('fs');
const { spawn } = require('child_process');

function usage() {
  console.error('Usage: detached-spawn.js [--cwd DIR] [--stdout FILE] [--stderr FILE] [--env KEY=VALUE] -- COMMAND [ARGS...]');
  process.exit(2);
}

const args = process.argv.slice(2);
let cwd = process.cwd();
let stdoutPath = '';
let stderrPath = '';
const env = { ...process.env };
let index = 0;
for (; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--') {
    index += 1;
    break;
  }
  if (arg === '--cwd' && args[index + 1]) {
    cwd = args[++index];
  } else if (arg === '--stdout' && args[index + 1]) {
    stdoutPath = args[++index];
  } else if (arg === '--stderr' && args[index + 1]) {
    stderrPath = args[++index];
  } else if (arg === '--env' && args[index + 1]) {
    const pair = args[++index];
    const equal = pair.indexOf('=');
    if (equal <= 0) usage();
    env[pair.slice(0, equal)] = pair.slice(equal + 1);
  } else {
    usage();
  }
}

const command = args[index];
if (!command) usage();
const commandArgs = args.slice(index + 1);
const stdout = stdoutPath ? fs.openSync(stdoutPath, 'a') : 'ignore';
const stderr = stderrPath ? fs.openSync(stderrPath, 'a') : stdout;
const child = spawn(command, commandArgs, {
  cwd,
  env,
  detached: true,
  stdio: ['ignore', stdout, stderr],
});
child.unref();
process.stdout.write(String(child.pid || ''));
