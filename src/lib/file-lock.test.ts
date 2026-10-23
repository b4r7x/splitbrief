import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { lockSibling, withFileLock } from './file-lock.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-lock-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const timeout = () => new Error('lock timeout');

describe('lockSibling', () => {
  it('appends a .lock suffix to the target path', () => {
    expect(lockSibling(join(dir, 'data.json'))).toBe(join(dir, 'data.json.lock'));
  });
});

describe('withFileLock', () => {
  it('names the file it locks, not its lock, when the folder takes no new file', () => {
    const target = join(dir, 'evidence.json');
    chmodSync(dir, 0o555);
    try {
      expect(() => withFileLock(target, timeout, () => 'never')).toThrow(
        expect.objectContaining({ code: 'EACCES', path: target }),
      );
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it('runs the critical section and returns its value', () => {
    const result = withFileLock(join(dir, 'a'), timeout, () => 42);
    expect(result).toBe(42);
  });

  it('removes the lock file after the critical section completes', () => {
    const target = join(dir, 'a');
    const lockPath = lockSibling(target);
    withFileLock(target, timeout, () => {
      expect(existsSync(lockPath)).toBe(true);
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('removes the lock file even when the critical section throws', () => {
    const target = join(dir, 'a');
    const lockPath = lockSibling(target);
    expect(() =>
      withFileLock(target, timeout, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('serializes nested acquisitions of distinct locks and releases both lock files', () => {
    const outerLock = lockSibling(join(dir, 'outer'));
    const innerLock = lockSibling(join(dir, 'inner'));
    withFileLock(join(dir, 'outer'), timeout, () => {
      expect(existsSync(outerLock)).toBe(true);
      withFileLock(join(dir, 'inner'), timeout, () => {
        expect(existsSync(innerLock)).toBe(true);
      });
      expect(existsSync(innerLock)).toBe(false);
    });
    expect(existsSync(outerLock)).toBe(false);
  });

  it('takes over a lock that has aged past the staleness threshold', () => {
    const target = join(dir, 'a');
    const lockPath = lockSibling(target);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 60_000 }));

    const result = withFileLock(target, timeout, () => 'acquired');

    expect(result).toBe('acquired');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('takes over a stale lock whose holder pid is not alive', () => {
    const target = join(dir, 'a');
    const lockPath = lockSibling(target);
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, acquiredAt: Date.now() }));

    const result = withFileLock(target, timeout, () => 'acquired');

    expect(result).toBe('acquired');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('takes over a lock with malformed contents', () => {
    const target = join(dir, 'a');
    const lockPath = lockSibling(target);
    writeFileSync(lockPath, 'not json');

    const result = withFileLock(target, timeout, () => 'acquired');

    expect(result).toBe('acquired');
  });

  it('leaves no stale sidecar files behind after reclaiming a stale lock', () => {
    const target = join(dir, 'a');
    const lockPath = lockSibling(target);
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, acquiredAt: Date.now() }));

    withFileLock(target, timeout, () => 'acquired');

    const leftovers = readdirSync(dir).filter((name) =>
      name.startsWith(`${basename(lockPath)}.stale.`),
    );
    expect(leftovers).toEqual([]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('preserves a live holder and leaves no sidecar when a takeover is contended', () => {
    const target = join(dir, 'a');
    const lockPath = lockSibling(target);
    const freshBytes = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
    writeFileSync(lockPath, freshBytes);

    expect(() => withFileLock(target, timeout, () => 'never')).toThrow('lock timeout');

    expect(readFileSync(lockPath, 'utf-8')).toBe(freshBytes);
    const leftovers = readdirSync(dir).filter((name) =>
      name.startsWith(`${basename(lockPath)}.stale.`),
    );
    expect(leftovers).toEqual([]);
  });
});
