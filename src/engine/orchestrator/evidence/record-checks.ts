import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import {
  createEvidenceLedger,
  findOrSeed,
  upsertEvidenceTask,
  withAppendedVerifyChecks,
} from '../../../core/evidence/ledger-state.js';
import { mutateEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { EVIDENCE_FILE } from '../../../core/paths.js';
import { sessionRelativePath } from '../../../core/sessions/ownership-marker.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { warnError } from '../../../lib/warn.js';
import { nowIso } from '../../../utils/format-time.js';
import {
  captureChangedFilesBaseline,
  changedFilesSinceBaseline,
  deserializeChangedFilesBaseline,
  type ChangedFilesBaseline,
} from '../changed-files-baseline.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { checkEntries } from './task.js';
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
  runs?: readonly CheckRunResult[] | undefined;
};

/** Books the runs on `task`, or with no task on the review that ran them. */
export async function recordCheckRuns(input: RecordCheckRunsInput): Promise<void> {
  const runs = [...(input.runs ?? [])];
  if (runs.length === 0) return;

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
    warnError(
      'Could not identify the current change, so the reviewer does not see the renders of these checks',
      err,
    );
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
        const entries = checkEntries({ runs, workspaceSnapshotId, ts });
        if (input.task === undefined) return withAppendedVerifyChecks(ledger, entries);
        const seeded = findOrSeed(ledger, input.task);
        return upsertEvidenceTask(ledger, {
          ...seeded,
          checks: [...(seeded.checks ?? []), ...entries],
        });
      },
    );
  } catch (err) {
    warnError(
      `Could not save the check results to ${sessionRelativePath(input.sessionId, EVIDENCE_FILE)}`,
      err,
    );
  }
}
