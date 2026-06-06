import { mkdtemp, rm, mkdir, utimes } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireSnapshotLock } from './lock.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'diptych-snapshot-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('acquireSnapshotLock', () => {
  it('succeeds on first call and releases cleanly', async () => {
    const release = await acquireSnapshotLock(tmp, 'sess-01');
    await release();
    const release2 = await acquireSnapshotLock(tmp, 'sess-01');
    await release2();
  });

  it('throws when lock already held', async () => {
    const release = await acquireSnapshotLock(tmp, 'sess-01');
    try {
      await expect(acquireSnapshotLock(tmp, 'sess-01')).rejects.toThrow(
        'Another snapshot operation is in progress for this session.',
      );
    } finally {
      await release();
    }
  });

  it('removes and retakes stale lock (mtime > 60s)', async () => {
    const lockDir = join(tmp, '.diptych', 'sessions', 'sess-01', 'snapshots');
    await mkdir(lockDir, { recursive: true });
    const lockPath = join(lockDir, '.lock');

    const fd = openSync(lockPath, 'wx');
    closeSync(fd);

    const oldDate = new Date(Date.now() - 120_000);
    await utimes(lockPath, oldDate, oldDate);

    const release = await acquireSnapshotLock(tmp, 'sess-01');
    await release();
  });
});
