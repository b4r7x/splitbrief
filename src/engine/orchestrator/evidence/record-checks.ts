import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
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
import { nowIso } from '../../../utils/format/time.js';
import {
  captureChangedFilesBaseline,
  changedFilesSinceBaseline,
  deserializeChangedFilesBaseline,
  type ChangedFilesBaseline,
} from '../changed-files-baseline.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import type { CheckRunResult } from '../validation/checks/types.js';
import type { EvidenceCheckEntry } from '../../../core/schemas/evidence.js';

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

type CheckEntryMeta = {
  workspaceSnapshotId?: string | undefined;
};

function runCheckEntry(run: CheckRunResult, meta: CheckEntryMeta, ts: string): EvidenceCheckEntry {
  const entry: EvidenceCheckEntry = { id: run.checkId, status: run.status, ts };
  if (run.command !== undefined) entry.command = run.command;
  if (run.exitCode !== undefined) entry.exitCode = run.exitCode;
  if (run.output.trim() !== '') entry.output = run.output;
  if (run.reusedAt !== undefined) entry.reusedAt = run.reusedAt;
  if (run.base !== undefined) {
    entry.base = {};
    if (run.base.exitCode !== undefined) entry.base.exitCode = run.base.exitCode;
    if (run.base.output.trim() !== '') entry.base.output = run.base.output;
  }
  if (run.preExisting !== undefined && run.preExisting.length > 0) {
    entry.preExisting = [...run.preExisting];
  }
  if (run.artifacts !== undefined && run.artifacts.length > 0) {
    entry.artifacts = run.artifacts.map((artifact) => ({
      path: artifact.path,
      sha256: artifact.sha256,
    }));
  }
  if (meta.workspaceSnapshotId !== undefined) entry.workspaceSnapshotId = meta.workspaceSnapshotId;
  return entry;
}

export function checkEntries(input: {
  runs?: readonly CheckRunResult[] | undefined;
  workspaceSnapshotId?: string | undefined;
  ts?: string | undefined;
}): EvidenceCheckEntry[] {
  const ts = input.ts ?? nowIso();
  const meta: CheckEntryMeta = { workspaceSnapshotId: input.workspaceSnapshotId };
  return (input.runs ?? []).map((run) => runCheckEntry(run, meta, ts));
}
