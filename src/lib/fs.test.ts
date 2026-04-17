import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { readFileOrEmpty, checkConfigPermissions } from './fs.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let tmp: string;

function makeTmp(): string {
  tmp = createTempDir('fs-test');
  return tmp;
}

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('readFileOrEmpty', () => {
  it('returns content when file exists', async () => {
    const dir = makeTmp();
    const file = join(dir, 'hello.txt');
    writeFileSync(file, 'hello world', 'utf-8');
    expect(await readFileOrEmpty(file)).toBe('hello world');
  });

  it('returns empty string when file does not exist', async () => {
    const dir = makeTmp();
    expect(await readFileOrEmpty(join(dir, 'nope.txt'))).toBe('');
  });
});

describe('checkConfigPermissions', () => {
  it('returns true for a file with 0o600 permissions', () => {
    const dir = makeTmp();
    const file = join(dir, 'secure.yaml');
    writeFileSync(file, 'key: value', { mode: 0o600 });
    expect(checkConfigPermissions(file)).toBe(true);
  });

  it('returns true for a file with 0o644 permissions', () => {
    const dir = makeTmp();
    const file = join(dir, 'readable.yaml');
    writeFileSync(file, 'key: value', { mode: 0o644 });
    expect(checkConfigPermissions(file)).toBe(true);
  });

  it('returns false for a file with 0o666 permissions', () => {
    const dir = makeTmp();
    const file = join(dir, 'open.yaml');
    writeFileSync(file, 'key: value');
    chmodSync(file, 0o666);
    expect(checkConfigPermissions(file)).toBe(false);
  });

  it('returns true for a file with 0o700 permissions (secure dir)', () => {
    const dir = makeTmp();
    const file = join(dir, 'dir-perm.yaml');
    writeFileSync(file, 'key: value');
    chmodSync(file, 0o700);
    expect(checkConfigPermissions(file)).toBe(true);
  });

  it('returns false for a file with 0o602 permissions (other-writable)', () => {
    const dir = makeTmp();
    const file = join(dir, 'world.yaml');
    writeFileSync(file, 'key: value');
    chmodSync(file, 0o602);
    expect(checkConfigPermissions(file)).toBe(false);
  });

  it('returns false when file does not exist', () => {
    const dir = makeTmp();
    expect(checkConfigPermissions(join(dir, 'missing.yaml'))).toBe(false);
  });
});
