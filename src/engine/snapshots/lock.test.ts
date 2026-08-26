import { mkdtemp, rm, mkdir, utimes, writeFile, readFile } from 'node:fs/promises';
import { openSync, closeSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireSnapshotLock } from './lock.js';

let tmp: string;

function snapshotLockPath(sessionId: string): string {
  return join(tmp, '.splitbrief', 'sessions', sessionId, 'snapshots', '.lock');
}

async function writeAgedLock(
  sessionId: string,
  payload: { pid: number; startedAt: number },
): Promise<string> {
  const lockDir = join(tmp, '.splitbrief', 'sessions', sessionId, 'snapshots');
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, '.lock');
  await writeFile(lockPath, JSON.stringify(payload));
  const oldDate = new Date(Date.now() - 120_000);
  await utimes(lockPath, oldDate, oldDate);
  return lockPath;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'splitbrief-snapshot-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('acquireSnapshotLock', () => {
  it('succeeds on first call and releases cleanly', async () => {
    const lockPath = snapshotLockPath('sess-01');
    const release = await acquireSnapshotLock(tmp, 'sess-01');
    await release();
    expect(existsSync(lockPath)).toBe(false);

    const release2 = await acquireSnapshotLock(tmp, 'sess-01');
    const onDisk = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(onDisk.pid).toBe(process.pid);
    await release2();
  });

  it('throws when lock already held', async () => {
    const release = await acquireSnapshotLock(tmp, 'sess-01');
    try {
      await expect(acquireSnapshotLock(tmp, 'sess-01')).rejects.toMatchObject({
        kind: 'snapshot-lock-busy',
      });
    } finally {
      await release();
    }
  });

  it('removes and retakes stale lock (mtime > 60s)', async () => {
    const lockDir = join(tmp, '.splitbrief', 'sessions', 'sess-01', 'snapshots');
    await mkdir(lockDir, { recursive: true });
    const lockPath = join(lockDir, '.lock');

    const fd = openSync(lockPath, 'wx');
    closeSync(fd);

    const oldDate = new Date(Date.now() - 120_000);
    await utimes(lockPath, oldDate, oldDate);

    const release = await acquireSnapshotLock(tmp, 'sess-01');

    const onDisk = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(onDisk.pid).toBe(process.pid);

    await release();
  });

  it('refuses a stale lock still held by a live process (busy with lock path)', async () => {
    const startedAt = Date.now() - process.uptime() * 1000;
    const lockPath = await writeAgedLock('sess-01', { pid: process.pid, startedAt });

    await expect(acquireSnapshotLock(tmp, 'sess-01')).rejects.toThrow(lockPath);

    const onDisk = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(onDisk.pid).toBe(process.pid);
  });

  it('steals a stale lock whose holding process is dead', async () => {
    const lockPath = await writeAgedLock('sess-01', { pid: 99_999_999, startedAt: 1 });

    const release = await acquireSnapshotLock(tmp, 'sess-01');

    const onDisk = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(onDisk.pid).toBe(process.pid);

    await release();
  });

  it('release does not delete a lock owned by another holder', async () => {
    const release = await acquireSnapshotLock(tmp, 'sess-01');

    const lockPath = snapshotLockPath('sess-01');
    await writeFile(lockPath, JSON.stringify({ pid: 4242, startedAt: 7 }));

    await release();

    const onDisk = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(onDisk.pid).toBe(4242);
  });
});
