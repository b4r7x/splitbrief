#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'opencode-shim.json'), 'utf8'));
const capture = config.capture;
const args = process.argv.slice(2);
if (args.indexOf('--version') !== -1) {
  process.stdout.write('1.18.15\n');
  process.exit(0);
}
if (args[0] === 'auth') process.exit(0);
const prompt = args[args.length - 1] ?? '';
fs.mkdirSync(capture, { recursive: true });
const counterPath = path.join(capture, 'counter');
let n = 0;
try {
  n = Number.parseInt(fs.readFileSync(counterPath, 'utf8'), 10) || 0;
} catch {}
n += 1;
fs.writeFileSync(counterPath, String(n));
let mode = 'batch';
try {
  const modes = fs.readFileSync(path.join(capture, 'modes.txt'), 'utf8').split('\n');
  mode = (modes[n - 1] ?? '').trim() || 'batch';
} catch {}
let failAt = 0;
try {
  failAt = Number.parseInt(fs.readFileSync(path.join(capture, 'fail-at'), 'utf8'), 10) || 0;
} catch {}
const items = [];
{
  const lines = prompt.split('\n');
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i] ?? '';
    const next = lines[i + 1] ?? '';
    if (!/^\s+Purpose:/.test(next)) continue;
    const start = line.indexOf('`');
    if (start < 0) continue;
    const end = line.indexOf('`', start + 1);
    if (end < 0) continue;
    const id = line.slice(start + 1, end);
    if (!/^[A-Za-z0-9]+$/.test(id)) continue;
    const close = line.lastIndexOf('`');
    if (close <= end) continue;
    const open = line.lastIndexOf('`', close - 1);
    if (open <= end) continue;
    const action = /(create|modify)/.exec(line);
    items.push({ id, action: action ? action[1] : 'create', file: line.slice(open + 1, close) });
  }
}
const marker = [
  'n=' + n,
  'mode=' + mode,
  'pid=' + process.pid,
  'cwd=' + process.cwd(),
  'home=' + (process.env.HOME ?? ''),
  'tmpdir=' + (process.env.TMPDIR ?? ''),
  'xdg_config_home=' + (process.env.XDG_CONFIG_HOME ?? ''),
  'argv=' + args.join(' '),
  'prompt_bytes=' + Buffer.byteLength(prompt, 'utf8'),
  'items=' + items.map((item) => item.id).join(','),
].join('\n');
fs.writeFileSync(path.join(capture, 'spawn-' + n + '.txt'), marker + '\n');
const emit = (text) => {
  process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text } }) + '\n');
};
const blockFor = (item) =>
  [
    '---',
    'id: ' + item.id,
    'title: "Task ' + item.id + '"',
    'action: ' + item.action,
    'file: ' + item.file,
    'depends_on: []',
    '---',
    '',
    '### Description',
    'Implement ' + item.file + '.',
    '',
    '### Tests',
    '- ' + item.id + ' works',
    '',
    '### Constraints',
    '- none',
    '',
  ].join('\n');
const emitItems = (list) => {
  for (const item of list) emit(blockFor(item));
};
const stepFinish = () => {
  process.stdout.write(
    JSON.stringify({
      type: 'step_finish',
      part: { type: 'step-finish', tokens: { input: 11, output: 22 } },
    }) + '\n',
  );
};
const bodies = {
  batch() {
    if (failAt > 0 && n === failAt) {
      process.stderr.write('fixture stderr\n');
      process.exit(17);
    }
    emitItems(items);
    stepFinish();
  },
  'partial-batch'() {
    emitItems(items.slice(0, 1));
    stepFinish();
  },
  'error-terminal'() {
    emitItems(items);
    process.stdout.write(JSON.stringify({ type: 'error', message: 'quota exceeded' }) + '\n');
  },
  research() {
    emit(config.research);
  },
  spec() {
    emit(config.spec);
  },
  plan() {
    emit(config.plan);
  },
  final() {
    emit(prompt.indexOf('first') !== -1 ? config.sentinelA : config.sentinelB);
  },
  hang() {
    const { spawn } = require('node:child_process');
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    fs.appendFileSync(path.join(capture, 'spawn-' + n + '.txt'), 'descendant=' + child.pid + '\n');
    setInterval(() => {}, 1000);
  },
  'flood-text'() {
    process.stdout.write(
      '{"type":"text","part":{"type":"text","text":"' + 'x'.repeat(102400) + '"}}\n',
    );
  },
  'flood-raw'() {
    for (let i = 0; i < 100; i += 1) {
      const record = {
        type: 'tool_use',
        part: {
          tool: 'read',
          id: 'read_' + i,
          name: 'read',
          state: { status: 'completed', input: { file: 'x' }, output: 'y'.repeat(2048) },
        },
      };
      process.stdout.write(JSON.stringify(record) + '\n');
    }
  },
};
const body = bodies[mode] ?? null;
if (body === null) {
  process.stderr.write('unknown mode: ' + mode + '\n');
  process.exit(2);
}
body();
