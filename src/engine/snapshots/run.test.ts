import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshotManifestPath } from '../../core/paths.js';
import type { SnapshotManifest } from '../../core/schemas/snapshot.js';
import { createSnapshot } from './create.js';
import {
  acceptRunSnapshot,
  readRunSnapshotLedger,
  recordRunSnapshot,
  rejectRunSnapshot,
} from './run.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'diptych-run-snapshot-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('rejectRunSnapshot', () => {
  it('returns "empty" when no run ledger has been recorded', async () => {
    await writeFile(join(tmp, 'feature.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    await writeFile(join(tmp, 'feature.ts'), 'after diptych');
    // User manually creates a snapshot with no run association.
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    const result = await rejectRunSnapshot(tmp, 'sess-01');

    expect(result).toEqual({ status: 'empty' });
    await expect(readFile(join(tmp, 'feature.ts'), 'utf-8')).resolves.toBe('after diptych');
  });

  it('restores modified files to the baseline when current hash matches the latest run snapshot', async () => {
    await writeFile(join(tmp, 'feature.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await writeFile(join(tmp, 'feature.ts'), 'after diptych');
    const runSnapshot = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
    });
    await recordRunSnapshot(tmp, 'sess-01', runSnapshot.manifest);

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
    const runSnapshot = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
    });
    await recordRunSnapshot(tmp, 'sess-01', runSnapshot.manifest);

    await writeFile(join(tmp, 'feature.ts'), 'user edit');
    const result = await rejectRunSnapshot(tmp, 'sess-01');

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.restoredPaths).toEqual([]);
      expect(result.conflictedPaths).toEqual(['feature.ts']);
    }
    await expect(readFile(join(tmp, 'feature.ts'), 'utf-8')).resolves.toBe('user edit');
  });

  it('remains retryable: a second confirmation after the user resolves the conflict completes the rejection', async () => {
    await writeFile(join(tmp, 'feature.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await writeFile(join(tmp, 'feature.ts'), 'after diptych');
    const runSnapshot = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
    });
    await recordRunSnapshot(tmp, 'sess-01', runSnapshot.manifest);

    // Conflict on first attempt.
    await writeFile(join(tmp, 'feature.ts'), 'user edit');
    const first = await rejectRunSnapshot(tmp, 'sess-01');
    expect(first.status).toBe('rejected');
    if (first.status === 'rejected') {
      expect(first.conflictedPaths).toEqual(['feature.ts']);
    }

    // Ledger must NOT be marked rejected — retry is required.
    let ledger = await readRunSnapshotLedger(tmp, 'sess-01');
    expect(ledger?.rejected).toBe(false);

    // User resolves the conflict by reverting the file to what the run wrote.
    await writeFile(join(tmp, 'feature.ts'), 'after diptych');

    // Second attempt completes successfully.
    const second = await rejectRunSnapshot(tmp, 'sess-01');
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') {
      expect(second.conflictedPaths).toEqual([]);
      expect(second.restoredPaths).toEqual(['feature.ts']);
    }
    await expect(readFile(join(tmp, 'feature.ts'), 'utf-8')).resolves.toBe('before');

    ledger = await readRunSnapshotLedger(tmp, 'sess-01');
    expect(ledger?.rejected).toBe(true);
  });

  it('does not re-conflict paths already restored during a previous partial reject', async () => {
    await writeFile(join(tmp, 'restored.ts'), 'before restored');
    await writeFile(join(tmp, 'conflicted.ts'), 'before conflicted');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await writeFile(join(tmp, 'restored.ts'), 'after restored');
    await writeFile(join(tmp, 'conflicted.ts'), 'after conflicted');
    const runSnapshot = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
    });
    await recordRunSnapshot(tmp, 'sess-01', runSnapshot.manifest);

    await writeFile(join(tmp, 'conflicted.ts'), 'user edit');

    const first = await rejectRunSnapshot(tmp, 'sess-01');
    expect(first.status).toBe('rejected');
    if (first.status === 'rejected') {
      expect(first.restoredPaths).toEqual(['restored.ts']);
      expect(first.conflictedPaths).toEqual(['conflicted.ts']);
    }
    await expect(readFile(join(tmp, 'restored.ts'), 'utf-8')).resolves.toBe('before restored');

    await writeFile(join(tmp, 'conflicted.ts'), 'after conflicted');

    const second = await rejectRunSnapshot(tmp, 'sess-01');
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') {
      expect(second.restoredPaths).toEqual(['conflicted.ts']);
      expect(second.conflictedPaths).toEqual([]);
    }
    await expect(readFile(join(tmp, 'restored.ts'), 'utf-8')).resolves.toBe('before restored');
    await expect(readFile(join(tmp, 'conflicted.ts'), 'utf-8')).resolves.toBe('before conflicted');
  });

  it('deletes files created by the run when current hash matches the latest run snapshot', async () => {
    await writeFile(join(tmp, 'existing.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await writeFile(join(tmp, 'created.ts'), 'created by diptych');
    const runSnapshot = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
    });
    await recordRunSnapshot(tmp, 'sess-01', runSnapshot.manifest);

    const result = await rejectRunSnapshot(tmp, 'sess-01');

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.deletedPaths).toEqual(['created.ts']);
    }
    expect(existsSync(join(tmp, 'created.ts'))).toBe(false);
  });

  it('refuses to act on a traversal path in the manifest and writes/deletes nothing outside the root', async () => {
    await writeFile(join(tmp, 'feature.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await writeFile(join(tmp, 'feature.ts'), 'after diptych');
    const runSnapshot = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
    });
    await recordRunSnapshot(tmp, 'sess-01', runSnapshot.manifest);

    // Tamper with the persisted run-snapshot manifest to smuggle in a path that
    // escapes the project root. rejectRunSnapshot must fail closed.
    const manifestFile = snapshotManifestPath(tmp, 'sess-01', runSnapshot.manifest.id);
    const tampered: SnapshotManifest = {
      ...runSnapshot.manifest,
      fileHashes: { ...runSnapshot.manifest.fileHashes, '../escape.txt': 'deadbeef' },
    };
    await writeFile(manifestFile, JSON.stringify(tampered, null, 2));

    const escapeTarget = resolve(tmp, '..', 'escape.txt');
    await expect(rejectRunSnapshot(tmp, 'sess-01')).rejects.toMatchObject({
      kind: 'path-confined-escape',
    });
    expect(existsSync(escapeTarget)).toBe(false);
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

  it('keeps accepted run state after later snapshots are created', async () => {
    await writeFile(join(tmp, 'feature.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    await writeFile(join(tmp, 'feature.ts'), 'after diptych');

    const accepted = await acceptRunSnapshot(tmp, 'sess-01');
    await writeFile(join(tmp, 'later.ts'), 'later snapshot');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    const result = await rejectRunSnapshot(tmp, 'sess-01');
    const ledger = await readRunSnapshotLedger(tmp, 'sess-01');

    expect(result).toEqual({ status: 'accepted', snapshotId: accepted.snapshotId });
    expect(ledger?.accepted).toBe(true);
    expect(ledger?.rejected).toBe(false);
    expect(ledger?.runSnapshotIds).toContain(accepted.snapshotId);
    expect(ledger?.beforeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(ledger?.lastDiptychHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('writes rejected state to the run ledger', async () => {
    await writeFile(join(tmp, 'feature.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    await writeFile(join(tmp, 'feature.ts'), 'after diptych');
    const runSnapshot = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
    });
    await recordRunSnapshot(tmp, 'sess-01', runSnapshot.manifest);

    await rejectRunSnapshot(tmp, 'sess-01');
    const ledger = await readRunSnapshotLedger(tmp, 'sess-01');

    expect(ledger?.accepted).toBe(false);
    expect(ledger?.rejected).toBe(true);
    expect(ledger?.runSnapshotIds).toContain(runSnapshot.manifest.id);
  });
});
