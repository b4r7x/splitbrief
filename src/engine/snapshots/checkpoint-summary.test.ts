import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SnapshotManifest, SnapshotPhase } from '../../core/schemas/snapshot.js';
import { acceptRunSnapshot, recordRunSnapshot } from './run.js';
import { writeManifest } from './store.js';
import {
  CHECKPOINT_RESTORE_SAFETY,
  listCheckpointSummaries,
} from './checkpoint-summary.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'diptych-checkpoint-summary-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeManifest(opts: {
  id: string;
  name?: string;
  phase?: SnapshotPhase;
  taskIndex?: number;
  trackedFileCount?: number;
}): SnapshotManifest {
  return {
    version: 1,
    id: opts.id,
    sessionId: 'sess-01',
    createdAt: `2026-04-28T10:00:0${opts.id.length % 10}.000Z`,
    phase: opts.phase ?? 'manual',
    fileHashes: {},
    fileEntries: [],
    trackedFileCount: opts.trackedFileCount ?? 0,
    ...(opts.name !== undefined && { name: opts.name }),
    ...(opts.taskIndex !== undefined && { taskIndex: opts.taskIndex }),
  };
}

async function writeSnapshot(opts: {
  id: string;
  name?: string;
  phase?: SnapshotPhase;
  taskIndex?: number;
  trackedFileCount?: number;
}): Promise<SnapshotManifest> {
  const manifest = makeManifest(opts);
  await writeManifest(tmp, 'sess-01', manifest);
  return manifest;
}

describe('listCheckpointSummaries', () => {
  it('returns an empty list when no snapshots exist', async () => {
    await expect(listCheckpointSummaries(tmp, 'sess-01')).resolves.toEqual([]);
  });

  it('hides the internal baseline snapshot from user-facing output', async () => {
    await writeSnapshot({ id: 'baseline', name: 'pre-task-0' });
    await writeSnapshot({ id: 'snap-01', name: 'manual checkpoint', trackedFileCount: 2 });

    const summaries = await listCheckpointSummaries(tmp, 'sess-01');

    expect(summaries.map((summary) => summary.id)).toEqual(['snap-01']);
  });

  it('uses missing-ledger name matches only as inferred kind fallback', async () => {
    await writeSnapshot({
      id: 'snap-pre-final',
      name: 'pre-final-review',
      taskIndex: 2,
      trackedFileCount: 5,
    });

    const summaries = await listCheckpointSummaries(tmp, 'sess-01');

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: 'snap-pre-final',
      name: 'pre-final-review',
      taskIndex: 2,
      trackedFileCount: 5,
      kind: 'manual',
      inferredKind: 'pre-final-review',
      isRunCheckpoint: false,
    });
  });

  it('keeps name-derived auto checkpoint labels as inferred kind even for run-ledger IDs', async () => {
    const runSnapshot = await writeSnapshot({
      id: 'snap-post-0',
      name: 'post-task-0',
      taskIndex: 0,
    });
    const preTaskSnapshot = await writeSnapshot({
      id: 'snap-pre-0',
      name: 'pre-task-0',
      taskIndex: 0,
    });
    const preFinalSnapshot = await writeSnapshot({
      id: 'snap-pre-final',
      name: 'pre-final-review',
    });
    await writeSnapshot({
      id: 'snap-post-1',
      name: 'post-task-1',
      taskIndex: 1,
    });
    const acceptedSnapshot = await writeSnapshot({
      id: 'snap-accepted',
      name: 'accepted-run',
    });
    await recordRunSnapshot(tmp, 'sess-01', runSnapshot);
    await recordRunSnapshot(tmp, 'sess-01', preTaskSnapshot);
    await recordRunSnapshot(tmp, 'sess-01', preFinalSnapshot);
    await recordRunSnapshot(tmp, 'sess-01', acceptedSnapshot);

    const summaries = await listCheckpointSummaries(tmp, 'sess-01');
    const accepted = summaries.find((summary) => summary.id === 'snap-accepted');
    const preTask = summaries.find((summary) => summary.id === 'snap-pre-0');
    const preFinal = summaries.find((summary) => summary.id === 'snap-pre-final');
    const postZero = summaries.find((summary) => summary.id === 'snap-post-0');
    const postOne = summaries.find((summary) => summary.id === 'snap-post-1');

    expect(accepted).toMatchObject({
      kind: 'manual',
      inferredKind: 'accepted-run',
      isRunCheckpoint: true,
    });
    expect(preTask).toMatchObject({
      kind: 'manual',
      inferredKind: 'pre-task',
      isRunCheckpoint: true,
    });
    expect(preFinal).toMatchObject({
      kind: 'manual',
      inferredKind: 'pre-final-review',
      isRunCheckpoint: true,
    });
    expect(postZero).toMatchObject({
      kind: 'manual',
      inferredKind: 'post-task',
      isRunCheckpoint: true,
    });
    expect(postOne).toMatchObject({
      kind: 'manual',
      inferredKind: 'post-task',
      isRunCheckpoint: false,
    });
  });

  it('uses run-ledger checkpoint kind when the ledger records authoritative classification', async () => {
    const postTask = await writeSnapshot({
      id: 'snap-post-0',
      name: 'post-task-0',
      taskIndex: 0,
    });
    const preFinal = await writeSnapshot({
      id: 'snap-pre-final',
      name: 'pre-final-review',
    });
    await recordRunSnapshot(tmp, 'sess-01', postTask, 'post-task');
    await recordRunSnapshot(tmp, 'sess-01', preFinal, 'pre-final-review');

    const summaries = await listCheckpointSummaries(tmp, 'sess-01');

    expect(summaries.find((summary) => summary.id === 'snap-post-0')).toMatchObject({
      kind: 'post-task',
      isRunCheckpoint: true,
    });
    expect(summaries.find((summary) => summary.id === 'snap-post-0')).not.toHaveProperty('inferredKind');
    expect(summaries.find((summary) => summary.id === 'snap-pre-final')).toMatchObject({
      kind: 'pre-final-review',
      isRunCheckpoint: true,
    });
    expect(summaries.find((summary) => summary.id === 'snap-pre-final')).not.toHaveProperty('inferredKind');
  });

  it('uses accepted run ledger state, not the accepted-run name, for accepted-run kind', async () => {
    await writeSnapshot({ id: 'baseline' });
    await writeSnapshot({ id: 'manual-accepted-name', name: 'accepted-run' });
    const accepted = await acceptRunSnapshot(tmp, 'sess-01');

    const summaries = await listCheckpointSummaries(tmp, 'sess-01');
    const manual = summaries.find((summary) => summary.id === 'manual-accepted-name');
    const acceptedRun = summaries.find((summary) => summary.id === accepted.snapshotId);

    expect(manual).toMatchObject({
      kind: 'manual',
      inferredKind: 'accepted-run',
      isRunCheckpoint: false,
    });
    expect(acceptedRun).toMatchObject({
      kind: 'accepted-run',
      isRunCheckpoint: true,
    });
    expect(acceptedRun).not.toHaveProperty('inferredKind');
  });

  it('does not treat manual snapshots named like auto checkpoints as run checkpoints', async () => {
    await writeSnapshot({ id: 'manual-pre-task', name: 'pre-task-0' });
    await writeSnapshot({ id: 'manual-accepted', name: 'accepted-run' });

    const summaries = await listCheckpointSummaries(tmp, 'sess-01');

    expect(summaries).toEqual([
      expect.objectContaining({
        id: 'manual-accepted',
        kind: 'manual',
        inferredKind: 'accepted-run',
        isRunCheckpoint: false,
      }),
      expect.objectContaining({
        id: 'manual-pre-task',
        kind: 'manual',
        inferredKind: 'pre-task',
        isRunCheckpoint: false,
      }),
    ]);
  });

  it('uses other for non-ledger non-manual snapshots while keeping name-derived inferred kind', async () => {
    await writeSnapshot({
      id: 'planning-pre-task',
      name: 'pre-task-4',
      phase: 'planning',
    });

    const summaries = await listCheckpointSummaries(tmp, 'sess-01');

    expect(summaries[0]).toMatchObject({
      kind: 'other',
      inferredKind: 'pre-task',
      isRunCheckpoint: false,
    });
  });

  it('builds exact ID-based diff and restore commands even when a name is present', async () => {
    await writeSnapshot({
      id: 'snap-command-id',
      name: 'pre-task-9',
    });

    const summaries = await listCheckpointSummaries(tmp, 'sess-01');

    expect(summaries[0]?.diffCommand).toBe('diptych snapshot diff snap-command-id');
    expect(summaries[0]?.restoreCommand).toBe('diptych snapshot restore snap-command-id');
  });

  it('includes structured restore safety metadata for checkpoint display surfaces', async () => {
    await writeSnapshot({ id: 'snap-safety' });

    const summaries = await listCheckpointSummaries(tmp, 'sess-01');

    expect(summaries[0]?.safety).toBe(CHECKPOINT_RESTORE_SAFETY);
    expect(summaries[0]?.safety).toMatchObject({
      hashGuarded: true,
      conflictsSkippedByDefault: true,
      forceOverwritesConflicts: true,
      partialRestoreExpected: true,
      excludedPaths: ['.git/', '.diptych/', 'node_modules/', '.trees/'],
    });
    expect(summaries[0]?.safety.text.hashGuarded).toContain('hash-guarded');
    expect(summaries[0]?.safety.text.conflictsSkippedByDefault).toContain('skipped by default');
    expect(summaries[0]?.safety.text.forceOverwritesConflicts).toContain('--force is destructive');
    expect(summaries[0]?.safety.text.forceOverwritesConflicts).toContain('overwrites conflicts');
    expect(summaries[0]?.safety.text.partialRestoreExpected).toContain('Partial restore is expected');
    expect(summaries[0]?.safety.text.excludedPaths).toContain('.diptych/');
  });
});
