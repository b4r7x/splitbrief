import { mkdtemp, rm, writeFile, unlink, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '../events/types.js';
import { createEventBus } from '../events/bus.js';
import { snapshotFilesDir } from '../../core/paths.js';
import { createSnapshot } from './store.js';
import { resolveSnapshot, restoreSnapshot } from './restore.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'diptych-restore-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeMockBus() {
  const events: EngineEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((e) => events.push(e));
  return { bus, events };
}

describe('restoreSnapshot — from baseline', () => {
  it('restores all files when no modifications post-snapshot', async () => {
    await writeFile(join(tmp, 'a.ts'), 'aaa');
    await writeFile(join(tmp, 'b.ts'), 'bbb');

    const baseline = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    const result = await restoreSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      idOrName: baseline.manifest.id,
    });

    expect(result.snapshotId).toBe('baseline');
    expect(result.conflictedPaths).toHaveLength(0);
    expect(result.forcedPaths).toHaveLength(0);
    expect(result.missingSnapshotFiles).toHaveLength(0);
    expect(result.restoredPaths.sort()).toEqual(expect.arrayContaining(['a.ts', 'b.ts']));
  });
});

describe('restoreSnapshot — from delta snapshot', () => {
  it('reconstructs: changed files from snapshot files/, unchanged from baseline files/', async () => {
    await writeFile(join(tmp, 'unchanged.ts'), 'same');
    await writeFile(join(tmp, 'changed.ts'), 'original');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await writeFile(join(tmp, 'changed.ts'), 'modified');
    const delta = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    // Confirm delta snapshot only has changed.ts in fileEntries
    expect(delta.manifest.fileEntries.some(e => e.path === 'changed.ts')).toBe(true);
    expect(delta.manifest.fileEntries.some(e => e.path === 'unchanged.ts')).toBe(false);

    // Now delete both files to force restore from storage (currentHash === null → always restored)
    await unlink(join(tmp, 'unchanged.ts'));
    await unlink(join(tmp, 'changed.ts'));

    const result = await restoreSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      idOrName: delta.manifest.id,
    });

    expect(result.conflictedPaths).toHaveLength(0);
    expect(result.restoredPaths).toContain('unchanged.ts');
    expect(result.restoredPaths).toContain('changed.ts');

    const { readFile } = await import('node:fs/promises');
    const unchangedContent = await readFile(join(tmp, 'unchanged.ts'), 'utf-8');
    const changedContent = await readFile(join(tmp, 'changed.ts'), 'utf-8');
    // unchanged.ts comes from baseline files/, changed.ts from delta files/
    expect(unchangedContent).toBe('same');
    expect(changedContent).toBe('modified');
  });
});

describe('restoreSnapshot — conflict detection', () => {
  it('skips and records conflict when file modified post-snapshot (different hash)', async () => {
    await writeFile(join(tmp, 'foo.ts'), 'original');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual', name: 'snap1' });

    // Modify the file after snapshot
    await writeFile(join(tmp, 'foo.ts'), 'modified after snapshot');

    const result = await restoreSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      idOrName: snap.manifest.id,
      force: false,
    });

    expect(result.conflictedPaths).toContain('foo.ts');
    expect(result.restoredPaths).not.toContain('foo.ts');
  });

  it('with force: true overwrites conflicted files, records in forcedPaths', async () => {
    await writeFile(join(tmp, 'foo.ts'), 'original');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual', name: 'snap1' });

    await writeFile(join(tmp, 'foo.ts'), 'modified after snapshot');

    const result = await restoreSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      idOrName: snap.manifest.id,
      force: true,
    });

    expect(result.forcedPaths).toContain('foo.ts');
    expect(result.conflictedPaths).not.toContain('foo.ts');
    expect(result.restoredPaths).not.toContain('foo.ts');

    const { readFile } = await import('node:fs/promises');
    const content = await readFile(join(tmp, 'foo.ts'), 'utf-8');
    expect(content).toBe('original');
  });
});

describe('restoreSnapshot — deleted file on disk', () => {
  it('restores file deleted from disk after snapshot (currentHash === null, no conflict)', async () => {
    await writeFile(join(tmp, 'gone.ts'), 'was here');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual', name: 'snap1' });

    await unlink(join(tmp, 'gone.ts'));

    const result = await restoreSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      idOrName: snap.manifest.id,
    });

    expect(result.restoredPaths).toContain('gone.ts');
    expect(result.conflictedPaths).not.toContain('gone.ts');

    const { readFile } = await import('node:fs/promises');
    const content = await readFile(join(tmp, 'gone.ts'), 'utf-8');
    expect(content).toBe('was here');
  });
});

describe('restoreSnapshot — missingSnapshotFiles', () => {
  it('records missingSnapshotFiles when snapshot file entry missing from files/ AND baseline entry also missing', async () => {
    await writeFile(join(tmp, 'foo.ts'), 'foo');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual', name: 'snap1' });

    // Manually corrupt: add a path to fileHashes with no entry in fileEntries or baseline
    const { writeManifest } = await import('./store.js');
    const corruptManifest = {
      ...snap.manifest,
      fileHashes: { ...snap.manifest.fileHashes, 'ghost.ts': 'deadbeef' },
    };
    await writeManifest(tmp, 'sess-01', corruptManifest);

    const result = await restoreSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      idOrName: snap.manifest.id,
    });

    expect(result.missingSnapshotFiles).toContain('ghost.ts');
  });
});

describe('restoreSnapshot — missing baseline', () => {
  it('throws "Baseline snapshot missing" when no baseline exists', async () => {
    // Write a manifest directly without creating a baseline
    const { writeManifest } = await import('./store.js');
    await writeManifest(tmp, 'sess-01', {
      version: 1,
      id: 'fake-snap',
      sessionId: 'sess-01',
      createdAt: new Date().toISOString(),
      phase: 'manual',
      fileHashes: { 'a.ts': 'abc' },
      fileEntries: [],
      trackedFileCount: 1,
    });

    await expect(
      restoreSnapshot({ projectDir: tmp, sessionId: 'sess-01', idOrName: 'fake-snap' }),
    ).rejects.toThrow('Baseline snapshot missing for session sess-01. Cannot restore.');
  });
});

describe('restoreSnapshot — lock release on error', () => {
  it('releases lock even when error thrown mid-restore', async () => {
    // No baseline exists — will throw during restore
    const { writeManifest } = await import('./store.js');
    await writeManifest(tmp, 'sess-01', {
      version: 1,
      id: 'snap-x',
      sessionId: 'sess-01',
      createdAt: new Date().toISOString(),
      phase: 'manual',
      fileHashes: {},
      fileEntries: [],
      trackedFileCount: 0,
    });

    await expect(
      restoreSnapshot({ projectDir: tmp, sessionId: 'sess-01', idOrName: 'snap-x' }),
    ).rejects.toThrow();

    // Lock should be released — can acquire again
    const { acquireSnapshotLock } = await import('./store.js');
    const release = await acquireSnapshotLock(tmp, 'sess-01');
    await release();
  });
});

describe('resolveSnapshot', () => {
  it('resolves by exact snapshot ID', async () => {
    await writeFile(join(tmp, 'x.ts'), 'x');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const delta = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    const resolved = await resolveSnapshot(tmp, 'sess-01', delta.manifest.id);
    expect(resolved.id).toBe(delta.manifest.id);
  });

  it('resolves by unique name', async () => {
    await writeFile(join(tmp, 'x.ts'), 'x');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    await writeFile(join(tmp, 'x.ts'), 'xx');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual', name: 'my-snap' });

    const resolved = await resolveSnapshot(tmp, 'sess-01', 'my-snap');
    expect(resolved.name).toBe('my-snap');
  });

  it('throws on zero name matches', async () => {
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await expect(resolveSnapshot(tmp, 'sess-01', 'nonexistent')).rejects.toThrow(
      'No snapshot found with id or name: nonexistent',
    );
  });

  it('throws on ambiguous name matches (two snapshots, same name)', async () => {
    await writeFile(join(tmp, 'x.ts'), 'v1');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await writeFile(join(tmp, 'x.ts'), 'v2');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual', name: 'dup' });

    await writeFile(join(tmp, 'x.ts'), 'v3');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual', name: 'dup' });

    await expect(resolveSnapshot(tmp, 'sess-01', 'dup')).rejects.toThrow(
      "Ambiguous snapshot name 'dup'",
    );
  });
});

describe('restoreSnapshot — event emission', () => {
  it('emits snapshot_restored on successful completion', async () => {
    await writeFile(join(tmp, 'a.ts'), 'aaa');
    const baseline = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    const { bus, events } = makeMockBus();
    await restoreSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      idOrName: baseline.manifest.id,
      bus,
    });

    const restoredEvt = events.find(e => e.type === 'snapshot_restored');
    expect(restoredEvt).toBeDefined();
    expect(restoredEvt?.type === 'snapshot_restored' && restoredEvt.snapshotId).toBe('baseline');
  });

  it('emits snapshot_restore_conflict when conflicts present and force is false', async () => {
    await writeFile(join(tmp, 'foo.ts'), 'original');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual', name: 'snap1' });

    await writeFile(join(tmp, 'foo.ts'), 'changed after');

    const { bus, events } = makeMockBus();
    await restoreSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      idOrName: snap.manifest.id,
      force: false,
      bus,
    });

    const conflictEvt = events.find(e => e.type === 'snapshot_restore_conflict');
    expect(conflictEvt).toBeDefined();

    const restoredEvt = events.find(e => e.type === 'snapshot_restored');
    expect(restoredEvt).toBeDefined();
  });

  it('does NOT emit snapshot_restore_conflict when force is true', async () => {
    await writeFile(join(tmp, 'foo.ts'), 'original');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const snap = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual', name: 'snap1' });

    await writeFile(join(tmp, 'foo.ts'), 'changed after');

    const { bus, events } = makeMockBus();
    await restoreSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      idOrName: snap.manifest.id,
      force: true,
      bus,
    });

    const conflictEvt = events.find(e => e.type === 'snapshot_restore_conflict');
    expect(conflictEvt).toBeUndefined();
  });

  it('refuses to restore a path whose stored blob has been corrupted, surfaces it as missingSnapshotFiles, and leaves disk untouched', async () => {
    await writeFile(join(tmp, 'foo.ts'), 'original-content');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await writeFile(join(tmp, 'foo.ts'), 'modified-by-diptych');
    const snap = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
      name: 'snap-corrupt',
    });

    // User accidentally overwrites the file on disk before restore.
    await writeFile(join(tmp, 'foo.ts'), 'user-edit-after-snapshot');

    // Tamper with the stored blob to simulate disk corruption.
    const filesDir = snapshotFilesDir(tmp, 'sess-01', snap.manifest.id);
    const blobs = await readdir(filesDir);
    expect(blobs.length).toBeGreaterThan(0);
    const blobPath = join(filesDir, blobs[0]!);
    await writeFile(blobPath, 'CORRUPTED-BYTES');

    const result = await restoreSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      idOrName: snap.manifest.id,
      force: true, // Even with force, a hash mismatch must NOT overwrite.
    });

    expect(result.missingSnapshotFiles).toContain('foo.ts');
    expect(result.restoredPaths).not.toContain('foo.ts');
    await expect(readFile(join(tmp, 'foo.ts'), 'utf-8')).resolves.toBe('user-edit-after-snapshot');
  });
});

describe('restoreSnapshot — path confinement', () => {
  it('rejects manifest paths that traverse outside the project via ../', async () => {
    await writeFile(join(tmp, 'safe.ts'), 'safe');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    const { writeManifest } = await import('./store.js');
    const snap = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    const corruptManifest = {
      ...snap.manifest,
      fileHashes: { ...snap.manifest.fileHashes, '../outside.txt': 'abc123' },
    };
    await writeManifest(tmp, 'sess-01', corruptManifest);

    await expect(
      restoreSnapshot({ projectDir: tmp, sessionId: 'sess-01', idOrName: snap.manifest.id }),
    ).rejects.toThrow(/unsafe path/);
  });

  it('rejects manifest paths that use absolute paths', async () => {
    await writeFile(join(tmp, 'safe.ts'), 'safe');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    const { writeManifest } = await import('./store.js');
    const snap = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    const corruptManifest = {
      ...snap.manifest,
      fileHashes: { ...snap.manifest.fileHashes, '/etc/passwd': 'abc123' },
    };
    await writeManifest(tmp, 'sess-01', corruptManifest);

    await expect(
      restoreSnapshot({ projectDir: tmp, sessionId: 'sess-01', idOrName: snap.manifest.id }),
    ).rejects.toThrow(/unsafe path/);
  });
});
