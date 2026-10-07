import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBareCommandOnPath } from './command-path.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const platform = process.platform;
const roots: string[] = [];

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function binDir(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'splitbrief-command-path-'));
  roots.push(root);
  const dir = join(root, name);
  mkdirSync(dir);
  return dir;
}

function executable(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
  return path;
}

describe('resolveBareCommandOnPath', () => {
  itUnix('returns the executable of the first PATH entry that holds the command', () => {
    const first = binDir('first');
    const second = binDir('second');
    const expected = executable(first, 'runner');
    executable(second, 'runner');

    expect(resolveBareCommandOnPath('runner', '/tmp', [first, second].join(delimiter))).toBe(
      expected,
    );
  });

  itUnix('skips a PATH entry whose file is not executable', () => {
    const first = binDir('first');
    const second = binDir('second');
    writeFileSync(join(first, 'runner'), '#!/bin/sh\n');
    chmodSync(join(first, 'runner'), 0o644);
    const expected = executable(second, 'runner');

    expect(resolveBareCommandOnPath('runner', '/tmp', [first, second].join(delimiter))).toBe(
      expected,
    );
  });

  itUnix('resolves through a PATH entry with a space in its name', () => {
    const dir = binDir('Program Files');
    const expected = executable(dir, 'runner');

    expect(resolveBareCommandOnPath('runner', '/tmp', dir)).toBe(expected);
  });

  it('tries the PATHEXT extensions in order on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('PATHEXT', '.EXE;.CMD');
    const dir = binDir('bin');
    executable(dir, 'runner.CMD');
    const expected = executable(dir, 'runner.EXE');

    expect(resolveBareCommandOnPath('runner', '/tmp', dir)).toBe(expected);
  });

  it('returns null when no PATH entry holds the command', () => {
    const dir = binDir('empty');

    expect(resolveBareCommandOnPath('runner', '/tmp', dir)).toBeNull();
  });
});
