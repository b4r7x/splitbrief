import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import type { EvidenceLedger, EvidenceTask } from '../../../../core/schemas/evidence.js';
import type { ReviewPacket } from '../../../../core/schemas/review/packet.js';
import type { Task, TaskId } from '../../../../core/schemas/task.js';
import { BRIEF_QUALITY_FILE, DRIFT_REPORT_FILE, EVIDENCE_FILE } from '../../../../core/paths.js';
import { countBySeverity, countByValue, uniqueSorted } from '../../../../utils/collections.js';
import type { DriftFinding, DriftReport } from '../../../../core/schemas/drift.js';
import type { BriefQualityArtifact, PacketEvent } from './types.js';

function taskEvidence(task: Task, ledger: EvidenceLedger | null): EvidenceTask | undefined {
  return ledger?.tasks.find((entry) => entry.id === task.id);
}

function groupDriftFindings(findings: DriftFinding[]): ReviewPacket['drift']['findingsBySeverity'] {
  return {
    info: findings.filter((finding) => finding.severity === 'info'),
    warning: findings.filter((finding) => finding.severity === 'warning'),
    error: findings.filter((finding) => finding.severity === 'error'),
  };
}

export function buildChanges(opts: {
  state: WorkflowState;
  ledger: EvidenceLedger | null;
  drift: DriftReport | null;
  changedFiles: string[];
}): ReviewPacket['changes'] {
  const { state, ledger, drift, changedFiles } = opts;
  const expectedFiles = uniqueSorted(
    drift?.expectedFiles ?? state.tasks.flatMap((task) => [...task.suggestedFiles]).filter(Boolean),
  );
  const outOfScopeFiles = uniqueSorted(
    (drift?.findings ?? [])
      .filter((finding) => finding.code === 'out_of_scope_file' && finding.file)
      .map((finding) => finding.file ?? ''),
  );
  const taskFileRows = state.tasks.map((task) => {
    const evidence = taskEvidence(task, ledger);
    const declared = task.suggestedFiles;
    return {
      taskId: task.id,
      title: task.title,
      file: task.suggestedFiles[0],
      files: [...declared],
      status: task.status,
      changedFiles:
        evidence?.changedFiles ?? changedFiles.filter((file) => declared.includes(file)),
    };
  });

  return {
    changedFiles,
    expectedFiles,
    outOfScopeFiles,
    taskFiles: taskFileRows,
    diffReference:
      'Review the working tree with `git diff`; full diffs are intentionally not embedded.',
  };
}

export function buildValidation(
  state: WorkflowState,
  ledger: EvidenceLedger | null,
): ReviewPacket['validation'] {
  // The plan checks run before the review are booked on the last brief; they are no brief's own.
  const planCheckIds = new Set((state.plan?.checks ?? []).map((check) => check.id));
  const tasks = state.tasks.map((task) => {
    const evidence = taskEvidence(task, ledger);
    return {
      taskId: task.id,
      title: task.title,
      status: evidence?.status ?? task.status,
      checks: (task.checkResults ?? [])
        .filter((result) => !planCheckIds.has(result.id))
        .map((result) => ({ id: result.id, status: result.status })),
    };
  });

  const statusCounts = countByValue(tasks, (task) => task.status);
  return {
    summary: {
      passed: statusCounts.done ?? 0,
      failed: statusCounts.failed ?? 0,
      skipped: statusCounts.skipped ?? 0,
      escalated: statusCounts.escalated ?? 0,
    },
    tasks,
    finalReviewEvidenceStatus: ledger?.finalReview?.status ?? null,
  };
}

export function buildChecks(opts: {
  ledger: EvidenceLedger | null;
  events: PacketEvent[];
}): ReviewPacket['checks'] {
  const booked = [
    ...(opts.ledger?.tasks ?? []).flatMap((task) =>
      (task.checks ?? []).map((entry) => ({ taskId: task.id, entry })),
    ),
    ...(opts.ledger?.verifyChecks ?? []).map((entry) => ({ taskId: undefined, entry })),
  ];
  const entries = booked.map(({ taskId, entry }) => ({
    ...(taskId !== undefined && { taskId }),
    id: entry.id,
    ...(entry.status !== undefined && { status: entry.status }),
    ...(entry.command !== undefined && { command: entry.command }),
    ...(entry.exitCode !== undefined && { exitCode: entry.exitCode }),
    ...(entry.output !== undefined && { output: entry.output }),
    ...(entry.preExisting !== undefined && { preExisting: [...entry.preExisting] }),
    ...(entry.artifacts !== undefined && {
      artifacts: entry.artifacts.map((artifact) => ({ ...artifact })),
    }),
    ...(entry.workspaceSnapshotId !== undefined && {
      workspaceSnapshotId: entry.workspaceSnapshotId,
    }),
    ts: entry.ts,
    ...(entry.reusedAt !== undefined && { reusedAt: entry.reusedAt }),
  }));
  const outsideReadPaths = [
    ...new Set(
      opts.events
        .filter((event) => event.type === 'warning' && event.code === 'isolation_outside_read')
        .map((event) => event.message ?? '')
        .filter((message) => message !== ''),
    ),
  ];
  return { entries, outsideReadPaths };
}

export function buildEvidence(ledger: EvidenceLedger | null): ReviewPacket['evidence'] {
  return {
    path: ledger ? EVIDENCE_FILE : null,
    present: ledger !== null,
    briefHash: ledger?.briefHash ?? null,
    finalReview: ledger?.finalReview ?? null,
    approvals: ledger?.approvals ?? [],
    rejections: ledger?.rejections ?? [],
    reviews: ledger?.reviews ?? [],
  };
}

export function buildDrift(opts: {
  drift: DriftReport | null;
  briefQuality: BriefQualityArtifact | null;
}): ReviewPacket['drift'] {
  const { drift, briefQuality } = opts;
  const findings = drift?.findings ?? [];
  const driftCounts = countBySeverity(findings);
  const briefQualityCounts = countBySeverity(briefQuality?.issues ?? []);
  return {
    path: drift ? DRIFT_REPORT_FILE : null,
    present: drift !== null,
    passed: drift?.passed ?? null,
    errorCount: driftCounts.error,
    warningCount: driftCounts.warning,
    changedFiles: drift?.changedFiles ?? [],
    expectedFiles: drift?.expectedFiles ?? [],
    findings,
    findingsBySeverity: groupDriftFindings(findings),
    briefHash: drift?.briefHash ?? null,
    briefQuality: {
      path: BRIEF_QUALITY_FILE,
      present: briefQuality !== null,
      passed: briefQuality?.passed ?? null,
      score: briefQuality?.score ?? null,
      errorCount: briefQualityCounts.error,
      warningCount: briefQualityCounts.warning,
    },
  };
}

export function buildEscalations(opts: {
  state: WorkflowState;
  ledger: EvidenceLedger | null;
  events: PacketEvent[];
}): ReviewPacket['escalations'] {
  const { state, ledger, events } = opts;
  const retryMap = retryCountsFromEvents(events, (event) => event.message);
  for (const entry of ledger?.tasks ?? []) {
    if (entry.retries <= 0) continue;
    const current = retryMap.get(entry.id);
    retryMap.set(entry.id, {
      retryCount: Math.max(current?.retryCount ?? 0, entry.retries),
      lastError: current?.lastError ?? null,
    });
  }

  const skippedReasons = new Map<TaskId, string>();
  for (const event of events) {
    if (
      event.type === 'task_skipped' &&
      event.taskId !== undefined &&
      event.message !== undefined
    ) {
      skippedReasons.set(event.taskId, event.message);
    }
  }

  return {
    retries: [...retryMap.entries()]
      .map(([taskIdValue, retry]) => ({ taskId: taskIdValue, ...retry }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId)),
    escalatedTasks: state.tasks
      .filter(
        (task) => task.status === 'escalated' || taskEvidence(task, ledger)?.escalated === true,
      )
      .map((task) => {
        const evidence = taskEvidence(task, ledger);
        return {
          taskId: task.id,
          title: task.title,
          ...(evidence?.method !== undefined && { method: evidence.method }),
        };
      }),
    skippedTasks: state.tasks
      .filter((task) => task.status === 'skipped')
      .map((task) => ({
        taskId: task.id,
        title: task.title,
        reason: skippedReasons.get(task.id) ?? null,
      })),
    failedTasks: state.tasks
      .filter((task) => task.status === 'failed')
      .map((task) => ({ taskId: task.id, title: task.title })),
    warnings: events.filter((event) => event.type === 'warning'),
  };
}
export type RetryCount = {
  retryCount: number;
  lastError: string | null;
};

export function retryCountsFromEvents<TEvent extends { type: string; taskId?: string | undefined }>(
  events: Iterable<TEvent>,
  errorMessage: (event: TEvent) => string | null | undefined,
): Map<NonNullable<TEvent['taskId']>, RetryCount> {
  const retries = new Map<NonNullable<TEvent['taskId']>, RetryCount>();
  for (const event of events) {
    if (event.type !== 'task_retry' || event.taskId === undefined) continue;
    const current = retries.get(event.taskId) ?? { retryCount: 0, lastError: null };
    retries.set(event.taskId, {
      retryCount: current.retryCount + 1,
      lastError: errorMessage(event) ?? current.lastError,
    });
  }
  return retries;
}
