import type { RunSnapshotKind, SnapshotManifest, SnapshotPhase } from '../../core/schemas/snapshot.js';
import { SNAPSHOT_BASELINE_ID } from '../../core/paths.js';
import { readRunSnapshotLedger } from './run.js';
import { listSnapshots } from './store.js';

export type CheckpointDisplayKind =
  | 'manual'
  | 'pre-task'
  | 'post-task'
  | 'pre-final-review'
  | 'accepted-run'
  | 'other';

export type InferredCheckpointKind = Exclude<CheckpointDisplayKind, 'manual' | 'other'>;

export type CheckpointRestoreSafety = {
  readonly hashGuarded: true;
  readonly conflictsSkippedByDefault: true;
  readonly forceOverwritesConflicts: true;
  readonly partialRestoreExpected: true;
  readonly excludedPaths: readonly string[];
  readonly text: {
    readonly hashGuarded: string;
    readonly conflictsSkippedByDefault: string;
    readonly forceOverwritesConflicts: string;
    readonly partialRestoreExpected: string;
    readonly excludedPaths: string;
  };
};

export type CheckpointSummary = {
  id: string;
  name?: string;
  createdAt: string;
  phase: SnapshotPhase;
  taskIndex?: number;
  trackedFileCount: number;
  kind: CheckpointDisplayKind;
  inferredKind?: InferredCheckpointKind;
  isRunCheckpoint: boolean;
  diffCommand: string;
  restoreCommand: string;
  safety: CheckpointRestoreSafety;
};

export const CHECKPOINT_RESTORE_SAFETY = {
  hashGuarded: true,
  conflictsSkippedByDefault: true,
  forceOverwritesConflicts: true,
  partialRestoreExpected: true,
  excludedPaths: ['.git/', '.diptych/', 'node_modules/', '.trees/'],
  text: {
    hashGuarded: 'Restore is hash-guarded against files changed since the checkpoint.',
    conflictsSkippedByDefault: 'Conflicted files are skipped by default.',
    forceOverwritesConflicts: '--force is destructive and overwrites conflicts.',
    partialRestoreExpected: 'Partial restore is expected: safe files restore while conflicts are listed.',
    excludedPaths: 'Snapshots exclude .git/, .diptych/, node_modules/, and .trees/.',
  },
} as const satisfies CheckpointRestoreSafety;

function inferKindFromName(name: string | undefined): InferredCheckpointKind | undefined {
  if (name === undefined) return undefined;
  if (/^pre-task-\d+$/.test(name)) return 'pre-task';
  if (/^post-task-\d+$/.test(name)) return 'post-task';
  if (name === 'pre-final-review') return 'pre-final-review';
  if (name === 'accepted-run') return 'accepted-run';
  return undefined;
}

function displayKindForSnapshot(
  manifest: SnapshotManifest,
  isRunCheckpoint: boolean,
  acceptedRunSnapshotId: string | undefined,
  runSnapshotKind: RunSnapshotKind | undefined,
): CheckpointDisplayKind {
  if (isRunCheckpoint && runSnapshotKind !== undefined) return runSnapshotKind;
  if (isRunCheckpoint && manifest.id === acceptedRunSnapshotId) return 'accepted-run';
  if (manifest.phase === 'manual') return 'manual';
  return 'other';
}

function toCheckpointSummary(
  manifest: SnapshotManifest,
  runSnapshotIds: ReadonlySet<string>,
  acceptedRunSnapshotId: string | undefined,
  runSnapshotKind: RunSnapshotKind | undefined,
): CheckpointSummary {
  const isRunCheckpoint = runSnapshotIds.has(manifest.id);
  const inferredKind = inferKindFromName(manifest.name);
  const kind = displayKindForSnapshot(manifest, isRunCheckpoint, acceptedRunSnapshotId, runSnapshotKind);
  const summary: CheckpointSummary = {
    id: manifest.id,
    createdAt: manifest.createdAt,
    phase: manifest.phase,
    trackedFileCount: manifest.trackedFileCount,
    kind,
    isRunCheckpoint,
    diffCommand: `diptych snapshot diff ${manifest.id}`,
    restoreCommand: `diptych snapshot restore ${manifest.id}`,
    safety: CHECKPOINT_RESTORE_SAFETY,
    ...(manifest.name !== undefined && { name: manifest.name }),
    ...(manifest.taskIndex !== undefined && { taskIndex: manifest.taskIndex }),
    ...(inferredKind !== undefined && inferredKind !== kind && { inferredKind }),
  };
  return summary;
}

export async function listCheckpointSummaries(
  projectDir: string,
  sessionId: string,
): Promise<CheckpointSummary[]> {
  const { manifests } = await listSnapshots(projectDir, sessionId);
  const ledger = await readRunSnapshotLedger(projectDir, sessionId);
  const runSnapshotIds = new Set(ledger?.runSnapshotIds ?? []);
  const acceptedRunSnapshotId = ledger?.accepted === true
    ? ledger.runSnapshotIds.at(-1)
    : undefined;

  return manifests
    .filter((manifest) => manifest.id !== SNAPSHOT_BASELINE_ID)
    .map((manifest) => toCheckpointSummary(
      manifest,
      runSnapshotIds,
      acceptedRunSnapshotId,
      ledger?.runSnapshotKinds?.[manifest.id],
    ));
}
