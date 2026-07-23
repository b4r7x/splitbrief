import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
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
  it('runs the critical section and returns its value', () => {
    const result = withFileLock(join(dir, 'a.lock'), timeout, () => 42);
    expect(result).toBe(42);
  });

  it('removes the lock file after the critical section completes', () => {
    const lockPath = join(dir, 'a.lock');
    withFileLock(lockPath, timeout, () => {
      expect(existsSync(lockPath)).toBe(true);
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('removes the lock file even when the critical section throws', () => {
    const lockPath = join(dir, 'a.lock');
    expect(() =>
      withFileLock(lockPath, timeout, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('serializes nested acquisitions of distinct locks and releases both lock files', () => {
    const outerLock = join(dir, 'outer.lock');
    const innerLock = join(dir, 'inner.lock');
    withFileLock(outerLock, timeout, () => {
      expect(existsSync(outerLock)).toBe(true);
      withFileLock(innerLock, timeout, () => {
        expect(existsSync(innerLock)).toBe(true);
      });
      expect(existsSync(innerLock)).toBe(false);
    });
    expect(existsSync(outerLock)).toBe(false);
  });

  it('takes over a lock that has aged past the staleness threshold', () => {
    const lockPath = join(dir, 'a.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 60_000 }));

    const result = withFileLock(lockPath, timeout, () => 'acquired');

    expect(result).toBe('acquired');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('takes over a stale lock whose holder pid is not alive', () => {
    const lockPath = join(dir, 'a.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, acquiredAt: Date.now() }));

    const result = withFileLock(lockPath, timeout, () => 'acquired');

    expect(result).toBe('acquired');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('takes over a lock with malformed contents', () => {
    const lockPath = join(dir, 'a.lock');
    writeFileSync(lockPath, 'not json');

    const result = withFileLock(lockPath, timeout, () => 'acquired');

    expect(result).toBe('acquired');
  });

  it('leaves no stale sidecar files behind after reclaiming a stale lock', () => {
    const lockPath = join(dir, 'a.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, acquiredAt: Date.now() }));

    withFileLock(lockPath, timeout, () => 'acquired');

    const leftovers = readdirSync(dir).filter((name) =>
      name.startsWith(`${basename(lockPath)}.stale.`),
    );
    expect(leftovers).toEqual([]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('preserves a live holder and leaves no sidecar when a takeover is contended', () => {
    const lockPath = join(dir, 'a.lock');
    const freshBytes = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
    writeFileSync(lockPath, freshBytes);

    expect(() => withFileLock(lockPath, timeout, () => 'never')).toThrow('lock timeout');

    expect(readFileSync(lockPath, 'utf-8')).toBe(freshBytes);
    const leftovers = readdirSync(dir).filter((name) =>
      name.startsWith(`${basename(lockPath)}.stale.`),
    );
    expect(leftovers).toEqual([]);
  });
});
