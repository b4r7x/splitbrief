import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SnapshotManifest } from '../../core/schemas/snapshot.js';
import {
  hasBaseline,
  listSnapshotIds,
  listSnapshots,
  readManifest,
  writeManifest,
} from './manifest.js';
import { createSnapshot } from './create.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'splitbrief-snapshot-'));
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

describe('writeManifest / readManifest', () => {
  it('creates dir and file; readManifest parses back to the same shape', async () => {
    const manifest = makeManifest('snap-01');
    await writeManifest(tmp, 'sess-01', manifest);
    const loaded = await readManifest(tmp, 'sess-01', 'snap-01');
    expect(loaded).toEqual(manifest);
  });

  it('round-trips legal identity and file metadata without storing separate child output', async () => {
    const manifest: SnapshotManifest = {
      ...makeManifest('snap-identity'),
      name: 'before-implementation',
      fileHashes: { 'src/index.ts': 'sha256:abc123' },
      fileEntries: [
        {
          path: 'src/index.ts',
          hash: 'sha256:abc123',
          encodedName: 'src__index.ts',
        },
      ],
      trackedFileCount: 1,
    };

    await writeManifest(tmp, 'sess-01', manifest);
    const serialized = await readFile(
      join(
        tmp,
        '.splitbrief',
        'sessions',
        'sess-01',
        'snapshots',
        'snap-identity',
        'manifest.json',
      ),
      'utf8',
    );
    const loaded = await readManifest(tmp, 'sess-01', 'snap-identity');

    expect(serialized).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
    expect(loaded).toEqual(manifest);
  });

  it('throws for missing file', async () => {
    await expect(readManifest(tmp, 'sess-01', 'does-not-exist')).rejects.toMatchObject({
      kind: 'snapshot-manifest-not-found',
    });
  });

  it('throws for invalid JSON (Zod parse failure)', async () => {
    const dir = join(tmp, '.splitbrief', 'sessions', 'sess-01', 'snapshots', 'bad-snap');
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

describe('hasBaseline', () => {
  it('returns false when baseline does not exist', async () => {
    expect(await hasBaseline(tmp, 'sess-01')).toBe(false);
  });

  it('returns true when baseline manifest exists', async () => {
    await writeManifest(tmp, 'sess-01', makeManifest('baseline'));
    expect(await hasBaseline(tmp, 'sess-01')).toBe(true);
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
    expect(manifests.every((m) => m.id !== 'baseline')).toBe(true);
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

    const corruptDir = join(tmp, '.splitbrief', 'sessions', 'sess-01', 'snapshots', '0000-corrupt');
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(corruptDir, 'manifest.json'), '{"invalid": true}');

    const { manifests, corruptedIds } = await listSnapshots(tmp, 'sess-01');

    expect(manifests.every((m) => m.id !== '0000-corrupt')).toBe(true);
    expect(corruptedIds).toEqual(['0000-corrupt']);
  });
});
