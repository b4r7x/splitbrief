import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeSnapshotPath } from './path-codec.js';
import { snapshotManifestPath, snapshotsDir } from '../../core/paths.js';
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

  it('surfaces a session-mismatch error when a ledger belongs to a foreign session', async () => {
    // Record a run under session A, producing a ledger whose sessionId is A.
    await writeFile(join(tmp, 'feature.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-aaa', phase: 'manual' });
    await writeFile(join(tmp, 'feature.ts'), 'after diptych');
    const runSnapshot = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-aaa',
      phase: 'manual',
    });
    await recordRunSnapshot(tmp, 'sess-aaa', runSnapshot.manifest);

    // Plant session A's ledger (sessionId: 'sess-aaa') under session B's storage.
    const bSnapshotsDir = snapshotsDir(tmp, 'sess-bbb');
    await mkdir(bSnapshotsDir, { recursive: true });
    await copyFile(
      join(snapshotsDir(tmp, 'sess-aaa'), 'run-ledger.json'),
      join(bSnapshotsDir, 'run-ledger.json'),
    );

    // The mismatch must surface as a structured error, not collapse to
    // { status: 'empty' } from a swallowed ledger read.
    await expect(rejectRunSnapshot(tmp, 'sess-bbb')).rejects.toMatchObject({
      kind: 'snapshot-run-ledger-session-mismatch',
    });
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

  it('does not delete an outside file when a recorded path parent is replaced by a symlink', async () => {
    // Baseline has no file under sub/. The run creates sub/created.ts, so reject
    // would normally delete it. Replacing sub/ with a symlink to an outside dir
    // must make reject fail closed instead of unlinking the outside file.
    await writeFile(join(tmp, 'anchor.ts'), 'anchor');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await mkdir(join(tmp, 'sub'), { recursive: true });
    await writeFile(join(tmp, 'sub', 'created.ts'), 'created by diptych');
    const runSnapshot = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
    });
    await recordRunSnapshot(tmp, 'sess-01', runSnapshot.manifest);

    const outside = await mkdtemp(join(tmpdir(), 'diptych-outside-'));
    await writeFile(join(outside, 'created.ts'), 'created by diptych');
    try {
      await rm(join(tmp, 'sub', 'created.ts'));
      await rmdir(join(tmp, 'sub'));
      await symlink(outside, join(tmp, 'sub'));

      await expect(rejectRunSnapshot(tmp, 'sess-01')).rejects.toMatchObject({
        kind: 'path-confined-escape',
      });
      await expect(readFile(join(outside, 'created.ts'), 'utf-8')).resolves.toBe(
        'created by diptych',
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not restore through a symlinked parent that escapes the project root', async () => {
    // Baseline records sub/feature.ts; the run deletes it. Reject would restore
    // the baseline blob into <root>/sub/feature.ts. Replacing sub/ with a symlink
    // to an outside dir must make the restore write fail closed.
    await mkdir(join(tmp, 'sub'), { recursive: true });
    await writeFile(join(tmp, 'sub', 'feature.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await rm(join(tmp, 'sub', 'feature.ts'));
    const runSnapshot = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
    });
    await recordRunSnapshot(tmp, 'sess-01', runSnapshot.manifest);

    const outside = await mkdtemp(join(tmpdir(), 'diptych-restore-outside-'));
    try {
      await rmdir(join(tmp, 'sub'));
      await symlink(outside, join(tmp, 'sub'));

      await expect(rejectRunSnapshot(tmp, 'sess-01')).rejects.toMatchObject({
        kind: 'path-confined-escape',
      });
      expect(existsSync(join(outside, 'feature.ts'))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a tampered baseline manifest whose encodedName points outside snapshot storage', async () => {
    // Baseline records feature.ts; the run deletes it, so reject restores it from
    // the baseline blob. A tampered baseline entry whose encodedName decodes to an
    // outside path must be rejected by the validated blob resolver: the live file
    // is reported missing instead of being restored from arbitrary content.
    await writeFile(join(tmp, 'feature.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });

    await rm(join(tmp, 'feature.ts'));
    const runSnapshot = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'manual',
    });
    await recordRunSnapshot(tmp, 'sess-01', runSnapshot.manifest);

    const outsideBlob = resolve(tmp, '..', 'evil-blob');
    await writeFile(outsideBlob, 'evil');

    const baselineManifestFile = snapshotManifestPath(tmp, 'sess-01', 'baseline');
    const baselineRaw = JSON.parse(await readFile(baselineManifestFile, 'utf-8'));
    const traversalEncoded = encodeSnapshotPath(`../../../../../../..${outsideBlob}`);
    baselineRaw.fileEntries = baselineRaw.fileEntries.map(
      (e: { path: string; encodedName: string; hash: string }) =>
        e.path === 'feature.ts' ? { ...e, encodedName: traversalEncoded } : e,
    );
    await writeFile(baselineManifestFile, JSON.stringify(baselineRaw, null, 2));

    const result = await rejectRunSnapshot(tmp, 'sess-01');
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.restoredPaths).toEqual([]);
      expect(result.missingSnapshotFiles).toContain('feature.ts');
    }
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
  });

  it('does not persist a taskIndex field in the run ledger', async () => {
    await writeFile(join(tmp, 'feature.ts'), 'before');
    await createSnapshot({ projectDir: tmp, sessionId: 'sess-01', phase: 'manual' });
    await writeFile(join(tmp, 'feature.ts'), 'after diptych');
    const runSnapshot = await createSnapshot({
      projectDir: tmp,
      sessionId: 'sess-01',
      phase: 'implementing',
      taskIndex: 2,
    });
    await recordRunSnapshot(tmp, 'sess-01', runSnapshot.manifest);

    const raw = JSON.parse(
      await readFile(join(snapshotsDir(tmp, 'sess-01'), 'run-ledger.json'), 'utf-8'),
    );
    expect(raw).not.toHaveProperty('taskIndex');
    // The per-snapshot taskIndex still lives on the manifest it was captured at.
    expect(runSnapshot.manifest.taskIndex).toBe(2);
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
