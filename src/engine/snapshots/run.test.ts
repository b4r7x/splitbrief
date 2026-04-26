import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSnapshot } from './store.js';
import { acceptRunSnapshot, rejectRunSnapshot } from './run.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'diptych-run-snapshot-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('rejectRunSnapshot', () => {
  it('restores modified files to the baseline when current hash matches the latest run snapshot', async () => {
    await writeFile(join(tmp, 'feature.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await writeFile(join(tmp, 'feature.ts'), 'after diptych');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    const result = await rejectRunSnapshot(tmp, 'sess-01');

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.restoredPaths).toEqual(['feature.ts']);
      expect(result.conflictedPaths).toEqual([]);
    }
    await expect(readFile(join(tmp, 'feature.ts'), 'utf-8')).resolves.toBe('before');
  });

  it('preserves user edits made after the latest run snapshot and reports a conflict', async () => {
    await writeFile(join(tmp, 'feature.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await writeFile(join(tmp, 'feature.ts'), 'after diptych');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await writeFile(join(tmp, 'feature.ts'), 'user edit');
    const result = await rejectRunSnapshot(tmp, 'sess-01');

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.restoredPaths).toEqual([]);
      expect(result.conflictedPaths).toEqual(['feature.ts']);
    }
    await expect(readFile(join(tmp, 'feature.ts'), 'utf-8')).resolves.toBe('user edit');
  });

  it('deletes files created by the run when current hash matches the latest run snapshot', async () => {
    await writeFile(join(tmp, 'existing.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await writeFile(join(tmp, 'created.ts'), 'created by diptych');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    const result = await rejectRunSnapshot(tmp, 'sess-01');

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.deletedPaths).toEqual(['created.ts']);
    }
    expect(existsSync(join(tmp, 'created.ts'))).toBe(false);
  });

  it('refuses to reject after the run has been accepted', async () => {
    await writeFile(join(tmp, 'feature.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    await writeFile(join(tmp, 'feature.ts'), 'after diptych');

    const accepted = await acceptRunSnapshot(tmp, 'sess-01');
    const result = await rejectRunSnapshot(tmp, 'sess-01');

    expect(result).toEqual({ status: 'accepted', snapshotId: accepted.snapshotId });
    await expect(readFile(join(tmp, 'feature.ts'), 'utf-8')).resolves.toBe('after diptych');
  });
});
