import { chmod, mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventBus, EngineEvent } from '../events/types.js';
import { snapshotManifestPath } from '../../core/paths.js';
import { createSnapshot } from './create.js';
import { restoreSnapshot } from './restore.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'splitbrief-snapshot-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeMockBus(): { bus: EventBus; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  const bus: EventBus = {
    publish: (e) => events.push(e),
    subscribe: () => () => {},
  };
  return { bus, events };
}

describe('createSnapshot — first call (baseline)', () => {
  it('creates baseline dir with all tracked files and isFirstSnapshot: true', async () => {
    await writeFile(join(tmp, 'foo.ts'), 'export const x = 1;');
    await writeFile(join(tmp, 'bar.ts'), 'export const y = 2;');

    const result = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    expect(result.isFirstSnapshot).toBe(true);
    expect(result.manifest.id).toBe('baseline');
    expect(result.manifest.fileEntries.length).toBeGreaterThanOrEqual(2);
    expect(result.manifest.fileEntries.some((e) => e.path === 'foo.ts')).toBe(true);
    expect(result.manifest.fileEntries.some((e) => e.path === 'bar.ts')).toBe(true);

    const filesDir = join(result.snapshotDir, 'files');
    const written = await readdir(filesDir);
    expect(written.length).toBeGreaterThanOrEqual(2);
  });

  it('records file entries with only path, hash, and encodedName (no sizeBytes)', async () => {
    await writeFile(join(tmp, 'foo.ts'), 'export const x = 1;');

    const result = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    const entry = result.manifest.fileEntries.find((e) => e.path === 'foo.ts');
    expect(entry).toBeDefined();
    expect(Object.keys(entry ?? {}).sort()).toEqual(['encodedName', 'hash', 'path']);

    const manifestFile = snapshotManifestPath(
      { projectDir: tmp, sessionId: 'sess-01' },
      result.manifest.id,
    );
    const raw = JSON.parse(await readFile(manifestFile, 'utf-8'));
    for (const persisted of raw.fileEntries) {
      expect(persisted).not.toHaveProperty('sizeBytes');
    }
  });

  it('stores name in manifest when provided', async () => {
    const result = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
      name: 'before feature',
    });
    expect(result.manifest.name).toBe('before feature');
  });

  it('stores taskIndex in manifest when provided', async () => {
    const result = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
      taskIndex: 3,
    });
    expect(result.manifest.taskIndex).toBe(3);
  });

  it('excludes .splitbrief/ from tracked files (regression guard)', async () => {
    await writeFile(join(tmp, 'src.ts'), 'export {}');

    const result = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    expect(result.manifest.fileEntries.every((e) => !e.path.startsWith('.splitbrief/'))).toBe(true);
    expect(result.manifest.fileHashes).not.toHaveProperty('.splitbrief/active');
  });

  it('excludes .trees/ from tracked files so worktree clones never end up inside their parent snapshot', async () => {
    await writeFile(join(tmp, 'src.ts'), 'export {}');
    await mkdir(join(tmp, '.trees', 'feat-x', 'src'), { recursive: true });
    await writeFile(join(tmp, '.trees', 'feat-x', 'src', 'leaked.ts'), 'leaked');

    const result = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    expect(result.manifest.fileEntries.every((e) => !e.path.startsWith('.trees/'))).toBe(true);
    expect(Object.keys(result.manifest.fileHashes).every((p) => !p.startsWith('.trees/'))).toBe(
      true,
    );
  });

  it('round-trips two paths whose legacy encodings would have collided without losing data', async () => {
    await writeFile(join(tmp, 'a__b.ts'), 'literal underscores');
    await mkdir(join(tmp, 'a'), { recursive: true });
    await writeFile(join(tmp, 'a', 'b.ts'), 'nested path');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    await writeFile(join(tmp, 'a__b.ts'), 'literal underscores v2');
    await writeFile(join(tmp, 'a', 'b.ts'), 'nested path v2');
    const result = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    const entries = result.manifest.fileEntries.filter(
      (e) => e.path === 'a__b.ts' || e.path === 'a/b.ts',
    );
    expect(entries).toHaveLength(2);
    const encodedNames = new Set(entries.map((e) => e.encodedName));
    expect(encodedNames.size).toBe(2);
  });

  it('captures and restores a very long unicode path without ENAMETOOLONG', async () => {
    // hex(utf8(path)) doubled the byte count (worse for multi-byte chars), so a
    // deep CJK path blew past the 255-byte filename limit and lost its blob.
    // sha256 blob names are fixed length, so the round-trip stays intact.
    const longUnicodePath = `${'長い経路名フォルダ'.repeat(20)}.ts`;
    await writeFile(join(tmp, longUnicodePath), 'unicode content');

    const baseline = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
    });

    const entry = baseline.manifest.fileEntries.find((e) => e.path === longUnicodePath);
    expect(entry).toBeDefined();
    expect(entry?.encodedName).toMatch(/^[a-f0-9]{64}$/);

    await writeFile(join(tmp, longUnicodePath), 'clobbered');
    const result = await restoreSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      idOrName: baseline.manifest.id,
      force: true,
    });

    expect(result.forcedPaths).toContain(longUnicodePath);
    expect(await readFile(join(tmp, longUnicodePath), 'utf-8')).toBe('unicode content');
  });

  it('degrades on an unreadable source file: tracks the hash but writes no blob entry', async () => {
    await writeFile(join(tmp, 'readable.ts'), 'ok');
    const secret = join(tmp, 'secret.ts');
    await writeFile(secret, 'cannot read me');
    await chmod(secret, 0o200);

    try {
      const result = await createSnapshot({
        projectDir: tmp,
        sessionId: 'sess-01',
        phase: 'manual',
      });

      expect(Object.keys(result.manifest.fileHashes)).toContain('secret.ts');
      expect(result.manifest.fileEntries.some((e) => e.path === 'secret.ts')).toBe(false);
      expect(result.manifest.fileEntries.some((e) => e.path === 'readable.ts')).toBe(true);
    } finally {
      await chmod(secret, 0o600);
    }
  });

  it('emits snapshot_created when mock bus provided, with correct fileCount', async () => {
    await writeFile(join(tmp, 'a.ts'), 'a');
    await writeFile(join(tmp, 'b.ts'), 'b');

    const { bus, events } = makeMockBus();
    const result = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'implementing',
      bus,
      eventPhase: 'implementing',
    });

    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt?.type).toBe('snapshot_created');
    if (evt?.type === 'snapshot_created') {
      expect(evt.snapshotId).toBe('baseline');
      expect(evt.fileCount).toBe(result.manifest.trackedFileCount);
    }
  });
});

describe('createSnapshot — second call (delta snapshot)', () => {
  it('only stores changed files in fileEntries; unchanged files have no entry', async () => {
    await writeFile(join(tmp, 'unchanged.ts'), 'same content');
    await writeFile(join(tmp, 'changed.ts'), 'original');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await writeFile(join(tmp, 'changed.ts'), 'modified content');

    const { bus, events } = makeMockBus();
    const result = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'implementing',
      bus,
      eventPhase: 'implementing',
    });

    expect(result.isFirstSnapshot).toBe(false);
    expect(result.manifest.fileEntries.some((e) => e.path === 'changed.ts')).toBe(true);
    expect(result.manifest.fileEntries.some((e) => e.path === 'unchanged.ts')).toBe(false);
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt?.type).toBe('snapshot_created');
    if (evt?.type === 'snapshot_created') {
      expect(evt.fileCount).toBe(result.manifest.trackedFileCount);
    }
  });

  it('includes ALL tracked paths in fileHashes regardless of change status', async () => {
    await writeFile(join(tmp, 'a.ts'), 'aaa');
    await writeFile(join(tmp, 'b.ts'), 'bbb');

    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    await writeFile(join(tmp, 'a.ts'), 'modified');

    const result = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    expect(Object.keys(result.manifest.fileHashes)).toContain('a.ts');
    expect(Object.keys(result.manifest.fileHashes)).toContain('b.ts');
  });
});
