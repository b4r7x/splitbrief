import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSnapshot } from './store.js';
import { computeSnapshotDiff, formatSnapshotDiff } from './diff.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'diptych-diff-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('computeSnapshotDiff', () => {
  it('returns unchanged for all files immediately after snapshot', async () => {
    await writeFile(join(tmp, 'a.ts'), 'aaa');
    await writeFile(join(tmp, 'b.ts'), 'bbb');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual', name: 'snap1' });

    const result = await computeSnapshotDiff({
      projectDir: tmp,
      sessionId: 'sess-01',
      manifest: snap.manifest,
    });

    expect(result.changedCount).toBe(0);
    expect(result.files.every(f => f.status === 'unchanged')).toBe(true);
  });

  it('returns modified for a file with changed content', async () => {
    await writeFile(join(tmp, 'foo.ts'), 'original content');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual', name: 'snap1' });

    await writeFile(join(tmp, 'foo.ts'), 'modified content');

    const result = await computeSnapshotDiff({
      projectDir: tmp,
      sessionId: 'sess-01',
      manifest: snap.manifest,
    });

    const fooDiff = result.files.find(f => f.path === 'foo.ts');
    expect(fooDiff).toBeDefined();
    expect(fooDiff?.status).toBe('modified');
    expect(result.changedCount).toBe(1);
  });

  it('returns added for a new file created after snapshot', async () => {
    await writeFile(join(tmp, 'existing.ts'), 'existing');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual', name: 'snap1' });

    await writeFile(join(tmp, 'new-file.ts'), 'new content');

    const result = await computeSnapshotDiff({
      projectDir: tmp,
      sessionId: 'sess-01',
      manifest: snap.manifest,
    });

    const newFileDiff = result.files.find(f => f.path === 'new-file.ts');
    expect(newFileDiff).toBeDefined();
    expect(newFileDiff?.status).toBe('added');
    expect(result.changedCount).toBeGreaterThanOrEqual(1);
  });

  it('returns removed for a file deleted after snapshot', async () => {
    await writeFile(join(tmp, 'to-delete.ts'), 'will be deleted');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual', name: 'snap1' });

    await unlink(join(tmp, 'to-delete.ts'));

    const result = await computeSnapshotDiff({
      projectDir: tmp,
      sessionId: 'sess-01',
      manifest: snap.manifest,
    });

    const deletedFileDiff = result.files.find(f => f.path === 'to-delete.ts');
    expect(deletedFileDiff).toBeDefined();
    expect(deletedFileDiff?.status).toBe('removed');
    expect(result.changedCount).toBeGreaterThanOrEqual(1);
  });
});

describe('formatSnapshotDiff', () => {
  it('mentions the snapshot ID and indicates zero changes when changedCount is 0', () => {
    const result = {
      snapshotId: 'snap-abc',
      createdAt: '2026-04-26T12:00:00.000Z',
      files: [{ path: 'a.ts', status: 'unchanged' as const }],
      changedCount: 0,
    };

    const formatted = formatSnapshotDiff(result, { color: false });
    expect(formatted).toContain('snap-abc');
    expect(formatted).toMatch(/no\s+differences|0.*changed/i);
  });

  it('includes snapshot ID in header', () => {
    const result = {
      snapshotId: '2026-04-26T14-00-00-000Z',
      createdAt: '2026-04-26T14:00:00.000Z',
      files: [],
      changedCount: 0,
    };

    const formatted = formatSnapshotDiff(result, { color: false });
    expect(formatted).toContain('2026-04-26T14-00-00-000Z');
  });

  it('includes snapshot ID and numeric counts when there are changes', () => {
    const result = {
      snapshotId: 'snap-abc',
      createdAt: '2026-04-26T12:00:00.000Z',
      files: [
        { path: 'a.ts', status: 'modified' as const, diff: '--- a\n+++ b\n' },
        { path: 'b.ts', status: 'added' as const },
        { path: 'c.ts', status: 'removed' as const },
        { path: 'd.ts', status: 'unchanged' as const },
      ],
      changedCount: 3,
    };

    const formatted = formatSnapshotDiff(result, { color: false });
    expect(formatted).toContain('snap-abc');
    expect(formatted).toContain('3');
    expect(formatted).toMatch(/modified.*1/i);
    expect(formatted).toMatch(/added.*1/i);
    expect(formatted).toMatch(/removed.*1/i);
  });
});
