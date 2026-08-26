import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SnapshotManifest } from '../../core/schemas/snapshot.js';
import { snapshotManifestPath } from '../../core/paths.js';
import { createSnapshot } from './create.js';
import { computeSnapshotDiff, fallbackDiff, formatSnapshotDiff } from './diff.js';
import { encodeSnapshotPath } from './path-codec.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'splitbrief-diff-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('computeSnapshotDiff', () => {
  it('returns unchanged for all files immediately after snapshot', async () => {
    await writeFile(join(tmp, 'a.ts'), 'aaa');
    await writeFile(join(tmp, 'b.ts'), 'bbb');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
      name: 'snap1',
    });

    const result = await computeSnapshotDiff({
      projectDir: tmp,
      sessionId: 'sess-01',
      manifest: snap.manifest,
    });

    expect(result.changedCount).toBe(0);
    expect(result.files.every((f) => f.status === 'unchanged')).toBe(true);
  });

  it('returns modified for a file with changed content', async () => {
    await writeFile(join(tmp, 'foo.ts'), 'original content');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
      name: 'snap1',
    });

    await writeFile(join(tmp, 'foo.ts'), 'modified content');

    const result = await computeSnapshotDiff({
      projectDir: tmp,
      sessionId: 'sess-01',
      manifest: snap.manifest,
    });

    const fooDiff = result.files.find((f) => f.path === 'foo.ts');
    expect(fooDiff).toBeDefined();
    expect(fooDiff?.status).toBe('modified');
    expect(result.changedCount).toBe(1);
  });

  it('returns added for a new file created after snapshot', async () => {
    await writeFile(join(tmp, 'existing.ts'), 'existing');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
      name: 'snap1',
    });

    await writeFile(join(tmp, 'new-file.ts'), 'new content');

    const result = await computeSnapshotDiff({
      projectDir: tmp,
      sessionId: 'sess-01',
      manifest: snap.manifest,
    });

    const newFileDiff = result.files.find((f) => f.path === 'new-file.ts');
    expect(newFileDiff).toBeDefined();
    expect(newFileDiff?.status).toBe('added');
    expect(result.changedCount).toBeGreaterThanOrEqual(1);
  });

  it('returns removed for a file deleted after snapshot', async () => {
    await writeFile(join(tmp, 'to-delete.ts'), 'will be deleted');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
      name: 'snap1',
    });

    await unlink(join(tmp, 'to-delete.ts'));

    const result = await computeSnapshotDiff({
      projectDir: tmp,
      sessionId: 'sess-01',
      manifest: snap.manifest,
    });

    const deletedFileDiff = result.files.find((f) => f.path === 'to-delete.ts');
    expect(deletedFileDiff).toBeDefined();
    expect(deletedFileDiff?.status).toBe('removed');
    expect(result.changedCount).toBeGreaterThanOrEqual(1);
  });

  it('throws on a traversal path in the manifest instead of reading outside the root', async () => {
    await writeFile(join(tmp, 'a.ts'), 'aaa');
    const baseline = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
    });

    const tampered: SnapshotManifest = {
      ...baseline.manifest,
      id: 'tampered',
      fileHashes: { ...baseline.manifest.fileHashes, '../escape.txt': 'deadbeef' },
    };

    const escapeTarget = resolve(tmp, '..', 'escape.txt');
    await expect(
      computeSnapshotDiff({ projectDir: tmp, sessionId: 'sess-01', manifest: tampered }),
    ).rejects.toMatchObject({ kind: 'path-confined-escape' });
    expect(existsSync(escapeTarget)).toBe(false);
  });

  it('does not disclose an outside file when a recorded path parent is replaced by a symlink', async () => {
    await mkdir(join(tmp, 'sub'), { recursive: true });
    await writeFile(join(tmp, 'sub', 'file.ts'), 'in-repo');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
      name: 'snap1',
    });

    const outside = await mkdtemp(join(tmpdir(), 'splitbrief-diff-outside-'));
    await writeFile(join(outside, 'file.ts'), 'SECRET OUTSIDE CONTENT');
    try {
      await rm(join(tmp, 'sub', 'file.ts'));
      await rmdir(join(tmp, 'sub'));
      await symlink(outside, join(tmp, 'sub'));

      await expect(
        computeSnapshotDiff({ projectDir: tmp, sessionId: 'sess-01', manifest: snap.manifest }),
      ).rejects.toMatchObject({ kind: 'path-confined-escape' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not read a tampered delta blob whose encodedName decodes outside snapshot storage', async () => {
    await writeFile(join(tmp, 'foo.ts'), 'original');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    await writeFile(join(tmp, 'foo.ts'), 'changed by run');
    const snap = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
      name: 'snap1',
    });
    // Live content now differs from the snapshot, so diff must read the snapshot
    // blob — which the tampered encodedName points outside storage.
    await writeFile(join(tmp, 'foo.ts'), 'live working tree edit');

    const outsideBlob = resolve(tmp, '..', 'evil-diff-blob');
    await writeFile(outsideBlob, 'EVIL SNAPSHOT CONTENT');

    const manifestFile = snapshotManifestPath(
      { projectDir: tmp, sessionId: 'sess-01' },
      snap.manifest.id,
    );
    const raw = JSON.parse(await readFile(manifestFile, 'utf-8'));
    const traversalEncoded = encodeSnapshotPath(`../../../../../../..${outsideBlob}`);
    raw.fileEntries = raw.fileEntries.map((e: { path: string; encodedName: string }) =>
      e.path === 'foo.ts' ? { ...e, encodedName: traversalEncoded } : e,
    );
    await writeFile(manifestFile, JSON.stringify(raw, null, 2));
    const tampered = { ...snap.manifest, fileEntries: raw.fileEntries };

    const result = await computeSnapshotDiff({
      projectDir: tmp,
      sessionId: 'sess-01',
      manifest: tampered,
    });
    const fooDiff = result.files.find((f) => f.path === 'foo.ts');
    expect(fooDiff?.status).toBe('modified');
    expect(fooDiff?.diff ?? '').not.toContain('EVIL SNAPSHOT CONTENT');
  });
});

describe('fallbackDiff', () => {
  it('labels the headers and emits aligned add/remove lines for shared context', async () => {
    const snapshotFile = join(tmp, 'snap.txt');
    const currentFile = join(tmp, 'cur.txt');
    await writeFile(snapshotFile, 'line one\nline two\nline three');
    await writeFile(currentFile, 'line one\nline TWO changed\nline three');

    const diff = await fallbackDiff(snapshotFile, currentFile, 'src/foo.ts');

    expect(diff).toContain('--- snapshot/src/foo.ts');
    expect(diff).toContain('+++ current/src/foo.ts');
    expect(diff).toContain('- line two');
    expect(diff).toContain('+ line TWO changed');
    // Unchanged surrounding lines appear once as context, not duplicated as a
    // full remove-then-add block like the old degenerate differ produced.
    expect(diff).toContain('  line one');
    expect(diff.match(/line one/g)?.length).toBe(1);
  });

  it('returns an empty string when the two files are identical', async () => {
    const snapshotFile = join(tmp, 'snap.txt');
    const currentFile = join(tmp, 'cur.txt');
    await writeFile(snapshotFile, 'same\ncontent');
    await writeFile(currentFile, 'same\ncontent');

    expect(await fallbackDiff(snapshotFile, currentFile, 'src/foo.ts')).toBe('');
  });

  it('returns an empty string when either file is missing', async () => {
    const snapshotFile = join(tmp, 'snap.txt');
    await writeFile(snapshotFile, 'present');

    expect(await fallbackDiff(snapshotFile, join(tmp, 'absent.txt'), 'src/foo.ts')).toBe('');
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
