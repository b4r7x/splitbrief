import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { cleanupTempDir, createTempDir } from './temp-dir.js';

export interface ClipboardExecCall {
  file: string;
  args: string[];
  stdin: string;
}

interface SavedEnv {
  path: string | undefined;
  callsPath: string | undefined;
  exitCodes: string | undefined;
}

interface ClipboardExecFixture {
  calls: () => ClipboardExecCall[];
  reset: () => void;
  restore: () => void;
  setExitCodes: (codes: Record<string, number>) => void;
}

const COMMANDS = ['pbcopy', 'clip', 'wl-copy', 'xclip', 'xsel', 'tmux'] as const;
const CALLS_ENV = 'DIPTYCH_TEST_CLIPBOARD_CALLS';
const EXIT_CODES_ENV = 'DIPTYCH_TEST_CLIPBOARD_EXIT_CODES';

let active: ClipboardExecFixture | null = null;

function commandScript(): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const callsPath = process.env.${CALLS_ENV};
const exitCodes = JSON.parse(process.env.${EXIT_CODES_ENV} || '{}');
let stdin = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  const file = path.basename(process.argv[1] || '');
  if (callsPath) {
    fs.appendFileSync(callsPath, JSON.stringify({ file, args: process.argv.slice(2), stdin }) + '\\n');
  }
  const code = Number(exitCodes[file] ?? 0);
  process.exit(Number.isFinite(code) ? code : 1);
});
`;
}

function restoreEnv(saved: SavedEnv): void {
  if (saved.path === undefined) delete process.env['PATH'];
  else process.env['PATH'] = saved.path;

  if (saved.callsPath === undefined) delete process.env[CALLS_ENV];
  else process.env[CALLS_ENV] = saved.callsPath;

  if (saved.exitCodes === undefined) delete process.env[EXIT_CODES_ENV];
  else process.env[EXIT_CODES_ENV] = saved.exitCodes;
}

function readCalls(callsPath: string): ClipboardExecCall[] {
  if (!existsSync(callsPath)) return [];
  return readFileSync(callsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const call: ClipboardExecCall = JSON.parse(line);
      return call;
    });
}

export function installClipboardExecFixture(): ClipboardExecFixture {
  active?.restore();

  const root = createTempDir('clipboard-exec');
  const bin = join(root, 'bin');
  const callsPath = join(root, 'calls.jsonl');
  const saved: SavedEnv = {
    path: process.env['PATH'],
    callsPath: process.env[CALLS_ENV],
    exitCodes: process.env[EXIT_CODES_ENV],
  };

  mkdirSync(bin, { recursive: true });
  for (const command of COMMANDS) {
    const commandPath = join(bin, command);
    writeFileSync(commandPath, commandScript());
    chmodSync(commandPath, 0o755);
  }

  process.env['PATH'] = [bin, saved.path].filter(Boolean).join(delimiter);
  process.env[CALLS_ENV] = callsPath;
  process.env[EXIT_CODES_ENV] = '{}';

  const fixture: ClipboardExecFixture = {
    calls: () => readCalls(callsPath),
    reset: () => {
      rmSync(callsPath, { force: true });
      process.env[EXIT_CODES_ENV] = '{}';
    },
    restore: () => {
      restoreEnv(saved);
      cleanupTempDir(root);
      if (active === fixture) active = null;
    },
    setExitCodes: (codes) => {
      process.env[EXIT_CODES_ENV] = JSON.stringify(codes);
    },
  };

  active = fixture;
  return fixture;
}

export function readClipboardExecCalls(): ClipboardExecCall[] {
  return active?.calls() ?? [];
}

export function resetClipboardExecFixture(): void {
  active?.reset();
}

export function restoreClipboardExecFixture(): void {
  active?.restore();
}

export function setClipboardExitCodes(codes: Record<string, number>): void {
  active?.setExitCodes(codes);
}
