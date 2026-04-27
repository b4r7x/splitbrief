import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir, utimes, readdir } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleGit } from 'simple-git';
import type { SnapshotManifest } from '../../core/schemas/snapshot.js';
import type { EventBus, EngineEvent } from '../events/types.js';
import {
  acquireSnapshotLock,
  collectTrackedFiles,
  createSnapshot,
  decodeSnapshotPath,
  encodeSnapshotPath,
  generateSnapshotId,
  hasBaseline,
  hashFile,
  listSnapshotIds,
  listSnapshots,
  readManifest,
  writeManifest,
} from './store.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'diptych-snapshot-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeManifest(id: string): SnapshotManifest {
  return {
    version: 1,
    id,
    sessionId: 'sess-01',
    createdAt: new Date().toISOString(),
    phase: 'planning',
    fileHashes: {},
    fileEntries: [],
    trackedFileCount: 0,
  };
}

async function initGitRepo(dir: string): Promise<void> {
  await simpleGit(dir).init();
}

describe('generateSnapshotId', () => {
  it('produces a valid ISO slug with hyphens not colons', () => {
    const id = generateSnapshotId(new Date('2026-04-26T14:30:00.000Z'));
    expect(id).toBe('2026-04-26T14-30-00-000Z');
    expect(id).not.toContain(':');
    expect(id).not.toContain('.');
  });
});

describe('encodeSnapshotPath / decodeSnapshotPath', () => {
  it('roundtrips paths with slashes', () => {
    const original = 'src/core/paths.ts';
    expect(decodeSnapshotPath(encodeSnapshotPath(original))).toBe(original);
  });

  it('roundtrips paths with special characters', () => {
    const original = 'src/some file (with spaces) & stuff.ts';
    expect(decodeSnapshotPath(encodeSnapshotPath(original))).toBe(original);
  });

  it('encodes paths to a filesystem-safe form without slashes', () => {
    const encoded = encodeSnapshotPath('a/b/c.ts');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('\\');
    expect(encoded).toMatch(/^[a-f0-9]+$/);
  });

  it('produces distinct encodings for paths whose legacy double-underscore form would collide', () => {
    // The legacy encoding split on '/' and joined with '__', so 'a/b.ts'
    // and a single segment literally containing '__' could collide. Verify
    // the new encoding keeps them apart.
    const a = encodeSnapshotPath('a/b.ts');
    const b = encodeSnapshotPath('a__b.ts');
    expect(a).not.toBe(b);
    expect(decodeSnapshotPath(a)).toBe('a/b.ts');
    expect(decodeSnapshotPath(b)).toBe('a__b.ts');
  });
});

describe('writeManifest / readManifest', () => {
  it('creates dir and file; readManifest parses back to the same shape', async () => {
    const manifest = makeManifest('snap-01');
    await writeManifest(tmp, 'sess-01', manifest);
    const loaded = await readManifest(tmp, 'sess-01', 'snap-01');
    expect(loaded).toEqual(manifest);
  });

  it('throws for missing file', async () => {
    await expect(readManifest(tmp, 'sess-01', 'does-not-exist')).rejects.toThrow(
      'Snapshot manifest not found',
    );
  });

  it('throws for invalid JSON (Zod parse failure)', async () => {
    const dir = join(tmp, '.diptych', 'sessions', 'sess-01', 'snapshots', 'bad-snap');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), '{"version":99,"id":"bad-snap"}');
    await expect(readManifest(tmp, 'sess-01', 'bad-snap')).rejects.toThrow();
  });
});

describe('listSnapshotIds', () => {
  it('returns [] when snapshots dir missing', async () => {
    const ids = await listSnapshotIds(tmp, 'sess-01');
    expect(ids).toEqual([]);
  });

  it('returns sorted IDs across multiple snapshot dirs', async () => {
    for (const id of ['snap-b', 'snap-a', 'snap-c']) {
      await writeManifest(tmp, 'sess-01', makeManifest(id));
    }
    const ids = await listSnapshotIds(tmp, 'sess-01');
    expect(ids).toEqual(['snap-a', 'snap-b', 'snap-c']);
  });
});

describe('hashFile', () => {
  it('returns null for non-existent file', async () => {
    const result = await hashFile(join(tmp, 'nope.txt'));
    expect(result).toBeNull();
  });

  it('returns correct sha256 for known-content file', async () => {
    const content = 'hello world\n';
    const filePath = join(tmp, 'hello.txt');
    await writeFile(filePath, content);
    const expected = createHash('sha256').update(content).digest('hex');
    const result = await hashFile(filePath);
    expect(result).toBe(expected);
  });
});

describe('collectTrackedFiles', () => {
  it('excludes .git/, .diptych/, and node_modules/', async () => {
    await mkdir(join(tmp, '.git'), { recursive: true });
    await mkdir(join(tmp, '.diptych'), { recursive: true });
    await mkdir(join(tmp, 'node_modules', 'foo'), { recursive: true });
    await writeFile(join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(tmp, '.diptych', 'state.json'), '{}');
    await writeFile(join(tmp, 'node_modules', 'foo', 'index.js'), '');
    await writeFile(join(tmp, 'src.ts'), 'export {}');

    const files = await collectTrackedFiles(tmp);
    expect(files.some(f => f.startsWith('.git/'))).toBe(false);
    expect(files.some(f => f.startsWith('.diptych/'))).toBe(false);
    expect(files.some(f => f.startsWith('node_modules/'))).toBe(false);
    expect(files).toContain('src.ts');
  });

  it('excludes paths matched by .gitignore directory patterns', async () => {
    await initGitRepo(tmp);
    await writeFile(join(tmp, '.gitignore'), 'dist/\nbuild/\n');
    await mkdir(join(tmp, 'dist'), { recursive: true });
    await mkdir(join(tmp, 'src'), { recursive: true });
    await writeFile(join(tmp, 'dist', 'bundle.js'), '');
    await writeFile(join(tmp, 'src', 'index.ts'), '');

    const files = await collectTrackedFiles(tmp);
    expect(files.some(f => f.startsWith('dist/'))).toBe(false);
    expect(files).toContain('src/index.ts');
    expect(files).toContain('.gitignore');
  });

  it('uses git-compatible .gitignore matching for globs and negation', async () => {
    await initGitRepo(tmp);
    await writeFile(join(tmp, '.gitignore'), '*.log\ncoverage/**\n!important.log\n');
    await mkdir(join(tmp, 'coverage', 'nested'), { recursive: true });
    await writeFile(join(tmp, 'debug.log'), 'ignored');
    await writeFile(join(tmp, 'important.log'), 'kept');
    await writeFile(join(tmp, 'coverage', 'nested', 'report.json'), '{}');
    await writeFile(join(tmp, 'src.ts'), 'export {}');

    const files = await collectTrackedFiles(tmp);

    expect(files).not.toContain('debug.log');
    expect(files).not.toContain('coverage/nested/report.json');
    expect(files).toContain('important.log');
    expect(files).toContain('src.ts');
  });
});

describe('acquireSnapshotLock', () => {
  it('succeeds on first call and releases cleanly', async () => {
    const release = await acquireSnapshotLock(tmp, 'sess-01');
    await release();
    // Should be acquirable again after release
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
    // Create the lock directory first
    const lockDir = join(tmp, '.diptych', 'sessions', 'sess-01', 'snapshots');
    await mkdir(lockDir, { recursive: true });
    const lockPath = join(lockDir, '.lock');

    // Create a stale lock file manually
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);

    // Set mtime to 2 minutes ago
    const oldDate = new Date(Date.now() - 120_000);
    await utimes(lockPath, oldDate, oldDate);

    // Should be able to acquire despite the existing file
    const release = await acquireSnapshotLock(tmp, 'sess-01');
    await release();
  });
});

describe('hasBaseline', () => {
  it('returns false when baseline does not exist', async () => {
    expect(await hasBaseline(tmp, 'sess-01')).toBe(false);
  });

  it('returns true when baseline manifest exists', async () => {
    await writeManifest(tmp, 'sess-01', makeManifest('baseline'));
    expect(await hasBaseline(tmp, 'sess-01')).toBe(true);
  });
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
    expect(result.manifest.fileEntries.some(e => e.path === 'foo.ts')).toBe(true);
    expect(result.manifest.fileEntries.some(e => e.path === 'bar.ts')).toBe(true);

    // Baseline files dir should contain the written files
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

    expect(result.manifest.fileEntries.every(e => !e.path.startsWith('.diptych/'))).toBe(true);
    expect(result.manifest.fileHashes).not.toHaveProperty('.diptych/active');
  });

  it('excludes .trees/ from tracked files so worktree clones never end up inside their parent snapshot', async () => {
    await writeFile(join(tmp, 'src.ts'), 'export {}');
    await mkdir(join(tmp, '.trees', 'feat-x', 'src'), { recursive: true });
    await writeFile(join(tmp, '.trees', 'feat-x', 'src', 'leaked.ts'), 'leaked');

    const result = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    expect(result.manifest.fileEntries.every(e => !e.path.startsWith('.trees/'))).toBe(true);
    expect(Object.keys(result.manifest.fileHashes).every(p => !p.startsWith('.trees/'))).toBe(true);
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
      e => e.path === 'a__b.ts' || e.path === 'a/b.ts',
    );
    expect(entries).toHaveLength(2);
    const encodedNames = new Set(entries.map(e => e.encodedName));
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

    // Modify one file
    await writeFile(join(tmp, 'changed.ts'), 'modified content');

    const result = await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    expect(result.isFirstSnapshot).toBe(false);
    expect(result.manifest.fileEntries.some(e => e.path === 'changed.ts')).toBe(true);
    expect(result.manifest.fileEntries.some(e => e.path === 'unchanged.ts')).toBe(false);
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

describe('listSnapshots', () => {
  it('returns empty array if no snapshots dir exists', async () => {
    const { manifests } = await listSnapshots(tmp, 'sess-01');
    expect(manifests).toEqual([]);
  });

  it('EXCLUDES baseline from returned manifests', async () => {
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    const { manifests } = await listSnapshots(tmp, 'sess-01');
    expect(manifests.every(m => m.id !== 'baseline')).toBe(true);
  });

  it('returns manifests in ascending order across multiple snapshots', async () => {
    await writeFile(join(tmp, 'f.ts'), 'f');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    await writeFile(join(tmp, 'f.ts'), 'ff');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    await writeFile(join(tmp, 'f.ts'), 'fff');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    const { manifests } = await listSnapshots(tmp, 'sess-01');
    expect(manifests.length).toBe(2);
    expect(manifests[0]!.id < manifests[1]!.id).toBe(true);
  });

  it('skips corrupted manifest without throwing', async () => {
    await writeFile(join(tmp, 'g.ts'), 'g');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    // Write a corrupted snapshot dir
    const corruptDir = join(tmp, '.diptych', 'sessions', 'sess-01', 'snapshots', '0000-corrupt');
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(corruptDir, 'manifest.json'), '{"invalid": true}');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { manifests } = await listSnapshots(tmp, 'sess-01');
    warnSpy.mockRestore();

    // The corrupted entry is skipped, no throw
    expect(manifests.every(m => m.id !== '0000-corrupt')).toBe(true);
  });
});
