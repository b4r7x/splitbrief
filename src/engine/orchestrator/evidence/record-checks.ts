import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import {
  createEvidenceLedger,
  findOrSeed,
  withUpdatedTask,
} from '../../../core/evidence/ledger-state.js';
import { mutateEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { warnError } from '../../../lib/warn.js';
import { nowIso } from '../../../utils/format-time.js';
import {
  captureChangedFilesBaseline,
  changedFilesSinceBaseline,
  deserializeChangedFilesBaseline,
  type ChangedFilesBaseline,
} from '../changed-files-baseline.js';
import { hashTaskBrief } from '../../brief-hash.js';
import { checkEntries } from './task.js';
import type { ValidationResult } from '../validation/result.js';
import type { CheckRunResult } from '../validation/run-checks.js';

export async function currentCandidateId(
  workspaceDir: string,
  baseline: ChangedFilesBaseline,
): Promise<string> {
  const changed = await changedFilesSinceBaseline(workspaceDir, baseline);
  const files = [...new Set([...baseline.fingerprints.keys(), ...changed])];
  const captured = await captureChangedFilesBaseline(workspaceDir, files);
  const pairs = [...captured.fingerprints.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, hash]) => `${path}:${hash}`);
  return sha256Hex(pairs.join('\n'));
}

export type RecordCheckRunsInput = {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  workspaceDir: string;
  task?: Task | undefined;
  validation?: readonly ValidationResult[] | undefined;
  runs?: readonly CheckRunResult[] | undefined;
};

export async function recordCheckRuns(input: RecordCheckRunsInput): Promise<void> {
  const task = input.task ?? input.state.tasks[0];
  const validation = [...(input.validation ?? [])];
  const runs = [...(input.runs ?? [])];
  if (task === undefined || (validation.length === 0 && runs.length === 0)) return;

  const ts = nowIso();
  let workspaceSnapshotId: string | undefined;
  try {
    const baseline = input.state.changedFilesBaseline;
    if (baseline !== undefined) {
      workspaceSnapshotId = await currentCandidateId(
        input.workspaceDir,
        deserializeChangedFilesBaseline(baseline),
      );
    }
  } catch (err) {
    warnError('failed to compute the check-run candidate id', err);
  }

  try {
    mutateEvidenceLedger(
      { projectDir: input.projectDir, sessionId: input.sessionId },
      (existing) => {
        const briefHash = hashTaskBrief(input.state.tasks);
        const ledger =
          existing ??
          createEvidenceLedger({
            sessionId: input.sessionId,
            feature: input.state.feature,
            tasks: input.state.tasks,
            briefHash,
          });
        const seeded = ledger.tasks.some((entry) => entry.id === task.id)
          ? ledger
          : { ...ledger, tasks: [...ledger.tasks, findOrSeed(ledger, task, briefHash)] };
        return withUpdatedTask(seeded, task.id, (entry) => ({
          ...entry,
          checks: [
            ...(entry.checks ?? []),
            ...checkEntries({ validation, runs, workspaceSnapshotId, ts }),
          ],
        }));
      },
    );
  } catch (err) {
    warnError('failed to persist check runs', err);
  }
}
