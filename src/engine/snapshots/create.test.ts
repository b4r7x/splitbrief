import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventBus, EngineEvent } from '../events/types.js';
import { createSnapshot } from './create.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'diptych-snapshot-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeMockBus(): { bus: EventBus; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  const bus: EventBus = {
    publish: (e) => events.push(e),
    subscribe: () => () => {},
    unsubscribeAll: () => {},
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

  it('excludes .diptych/ from tracked files (regression guard)', async () => {
    await writeFile(join(tmp, 'src.ts'), 'export {}');

    const result = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    expect(result.manifest.fileEntries.every((e) => !e.path.startsWith('.diptych/'))).toBe(true);
    expect(result.manifest.fileHashes).not.toHaveProperty('.diptych/active');
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
    // Regression for the collision-free encoding: snapshot, modify both,
    // then re-snapshot and verify both files appear with distinct entries
    // and distinct stored blobs.
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

    const result = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    expect(result.isFirstSnapshot).toBe(false);
    expect(result.manifest.fileEntries.some((e) => e.path === 'changed.ts')).toBe(true);
    expect(result.manifest.fileEntries.some((e) => e.path === 'unchanged.ts')).toBe(false);
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

  it('emits snapshot_created with correct fileCount', async () => {
    await writeFile(join(tmp, 'x.ts'), 'x');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await writeFile(join(tmp, 'x.ts'), 'xx');
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
    if (evt?.type === 'snapshot_created') {
      expect(evt.fileCount).toBe(result.manifest.trackedFileCount);
    }
  });
});
