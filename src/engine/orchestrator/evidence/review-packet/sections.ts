import type { Summary } from '../../../../core/schemas/summary.js';
import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import type { EvidenceLedger, EvidenceTask } from '../../../../core/schemas/evidence.js';
import type { ReviewPacket } from '../../../../core/schemas/review-packet.js';
import type { Task, TaskId } from '../../../../core/schemas/task.js';
import {
  BRIEF_QUALITY_FILE,
  DRIFT_CHAINS_FILE,
  DRIFT_REPORT_FILE,
  EVIDENCE_FILE,
} from '../../../../core/paths.js';
import { countBySeverity, countByValue, uniqueSorted } from '../../../../utils/collections.js';
import { readDriftChainState } from '../../drift/chain-state.js';
import type { DriftFinding, DriftReport } from '../../../../core/schemas/drift.js';
import type { BuildReviewPacketOptions, BriefQualityArtifact, PacketEvent } from './types.js';
import { retryCountsFromEvents } from '../retry-counts.js';

function taskEvidence(task: Task, ledger: EvidenceLedger | null): EvidenceTask | undefined {
  return ledger?.tasks.find((entry) => entry.id === task.id);
}

function expectedEvidenceForTask(task: Task, evidence: EvidenceTask | undefined): string[] {
  if (evidence) return [...evidence.expectedEvidence];
  return [...(task.evidence ?? []), ...task.tests];
}

function missingExpectedEvidence(expectedEvidence: string[], observedEvidence: string[]): string[] {
  if (expectedEvidence.length === 0) return [];
  if (observedEvidence.length === 0) return [...expectedEvidence];
  return expectedEvidence.filter(
    (expected) =>
      !observedEvidence.some(
        (observed) => observed.includes(expected) || expected.includes(observed),
      ),
  );
}

function groupDriftFindings(findings: DriftFinding[]): ReviewPacket['drift']['findingsBySeverity'] {
  return {
    info: findings.filter((finding) => finding.severity === 'info'),
    warning: findings.filter((finding) => finding.severity === 'warning'),
    error: findings.filter((finding) => finding.severity === 'error'),
  };
}

export function buildChanges(
  state: WorkflowState,
  ledger: EvidenceLedger | null,
  drift: DriftReport | null,
  changedFiles: string[],
): ReviewPacket['changes'] {
  const expectedFiles = uniqueSorted(
    drift?.expectedFiles ?? state.tasks.map((task) => task.file).filter(Boolean),
  );
  const outOfScopeFiles = uniqueSorted(
    (drift?.findings ?? [])
      .filter((finding) => finding.code === 'out_of_scope_file' && finding.file)
      .map((finding) => finding.file ?? ''),
  );
  const taskFiles = state.tasks.map((task) => {
    const evidence = taskEvidence(task, ledger);
    const observedEvidence = evidence?.observedEvidence ?? [];
    return {
      taskId: task.id,
      title: task.title,
      file: task.file,
      status: task.status,
      changedFiles: evidence?.changedFiles ?? (changedFiles.includes(task.file) ? [task.file] : []),
      expectedEvidence: expectedEvidenceForTask(task, evidence),
      observedEvidence,
    };
  });

  return {
    changedFiles,
    expectedFiles,
    outOfScopeFiles,
    taskFiles,
    diffReference:
      'Review the working tree with `git diff`; full diffs are intentionally not embedded.',
  };
}

export function buildValidation(
  state: WorkflowState,
  ledger: EvidenceLedger | null,
): ReviewPacket['validation'] {
  const tasks = state.tasks.map((task) => {
    const evidence = taskEvidence(task, ledger);
    const expectedEvidence = expectedEvidenceForTask(task, evidence);
    const observedEvidence = evidence?.observedEvidence ?? [];
    return {
      taskId: task.id,
      title: task.title,
      status: evidence?.status ?? task.status,
      validation: (evidence?.validation ?? []).map((entry) => ({
        stage: entry.stage,
        passed: entry.passed,
        ...(entry.errorSummary !== undefined && { errorSummary: entry.errorSummary }),
      })),
      expectedEvidence,
      observedEvidence,
      missingExpectedEvidence: missingExpectedEvidence(expectedEvidence, observedEvidence),
    };
  });

  const statusCounts = countByValue(state.tasks, (task) => task.status);
  return {
    summary: ledger?.validationSummary ?? {
      passed: statusCounts.done ?? 0,
      failed: statusCounts.failed ?? 0,
      skipped: statusCounts.skipped ?? 0,
      escalated: statusCounts.escalated ?? 0,
    },
    tasks,
    finalReviewEvidenceStatus: ledger?.finalReview?.status ?? null,
    missingEvidenceWarnings: tasks.flatMap((task) =>
      task.missingExpectedEvidence.length > 0
        ? [`${task.taskId} missing expected evidence: ${task.missingExpectedEvidence.join(', ')}`]
        : [],
    ),
  };
}

export function buildEvidence(ledger: EvidenceLedger | null): ReviewPacket['evidence'] {
  return {
    path: ledger ? EVIDENCE_FILE : null,
    present: ledger !== null,
    briefHash: ledger?.briefHash ?? null,
    finalReview: ledger?.finalReview ?? null,
    approvals: ledger?.approvals ?? [],
    rejections: ledger?.rejections ?? [],
  };
}

export function buildDrift(
  projectDir: string,
  sessionId: string,
  drift: DriftReport | null,
  briefQuality: BriefQualityArtifact | null,
): ReviewPacket['drift'] {
  const chainState = readDriftChainState(projectDir, sessionId);
  const topChain =
    chainState && chainState.emittedChains.length > 0
      ? chainState.emittedChains.reduce((best, chain) => (best.score >= chain.score ? best : chain))
      : undefined;
  const findings = drift?.findings ?? [];
  const driftCounts = countBySeverity(findings);
  const briefQualityCounts = countBySeverity(briefQuality?.issues ?? []);
  return {
    path: drift ? DRIFT_REPORT_FILE : null,
    present: drift !== null,
    passed: drift?.passed ?? null,
    score: drift?.score ?? null,
    errorCount: driftCounts.error,
    warningCount: driftCounts.warning,
    changedFiles: drift?.changedFiles ?? [],
    expectedFiles: drift?.expectedFiles ?? [],
    findings,
    findingsBySeverity: groupDriftFindings(findings),
    briefHash: drift?.briefHash ?? null,
    chainSummary: {
      path: DRIFT_CHAINS_FILE,
      present: chainState !== null,
      emittedChainCount: chainState?.emittedChains.length ?? 0,
      topChain: topChain
        ? {
            chainLength: topChain.chainLength,
            score: topChain.score,
            uniqueOutOfBoundsFiles: topChain.uniqueOutOfBoundsFiles,
            representativePath: topChain.representativePath,
            detectedAtTaskId: topChain.detectedAtTaskId,
          }
        : null,
    },
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

export function buildEscalations(
  state: WorkflowState,
  ledger: EvidenceLedger | null,
  events: PacketEvent[],
): ReviewPacket['escalations'] {
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
  for (const entry of ledger?.tasks ?? []) {
    const reason = entry.observedEvidence.find((evidence) => evidence.startsWith('skipped: '));
    if (entry.status === 'skipped' && reason)
      skippedReasons.set(entry.id, reason.slice('skipped: '.length));
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
    warnings: events.filter(
      (event) =>
        event.type === 'warning' ||
        event.type === 'budget_warning' ||
        event.type === 'budget_paused' ||
        event.type === 'budget_exceeded',
    ),
  };
}

export function buildCost(summary: Summary, events: PacketEvent[]): ReviewPacket['cost'] {
  return {
    tokenUsage: summary.tokenUsage,
    costBreakdown: summary.costBreakdown
      ? {
          hypotheticalCost: summary.costBreakdown.hypotheticalCost,
          actualPlannerCost: summary.costBreakdown.actualPlannerCost,
          actualImplementerCost: summary.costBreakdown.actualImplementerCost,
          totalActualCost: summary.costBreakdown.totalActualCost,
          savingsAmount: summary.costBreakdown.savingsAmount,
          savingsPercentage: summary.costBreakdown.savingsPercentage,
          localCompletionRate: summary.costBreakdown.localCompletionRate,
          ...(summary.costBreakdown.hasPricedUsage !== undefined && {
            hasPricedUsage: summary.costBreakdown.hasPricedUsage,
          }),
          ...(summary.costBreakdown.hasUnpricedUsage !== undefined && {
            hasUnpricedUsage: summary.costBreakdown.hasUnpricedUsage,
          }),
          ...(summary.costBreakdown.hasSavingsEstimate !== undefined && {
            hasSavingsEstimate: summary.costBreakdown.hasSavingsEstimate,
          }),
          ...(summary.costBreakdown.isTotalActualCostKnown !== undefined && {
            isTotalActualCostKnown: summary.costBreakdown.isTotalActualCostKnown,
          }),
          ...(summary.costBreakdown.isAllPlannerBaselineKnown !== undefined && {
            isAllPlannerBaselineKnown: summary.costBreakdown.isAllPlannerBaselineKnown,
          }),
        }
      : null,
    estimatedCostSavings:
      summary.costBreakdown?.hasSavingsEstimate === false ? null : summary.estimatedCostSavings,
    taskRouting: summary.taskBreakdown ?? [],
    routingWarnings: events
      .filter(
        (event) =>
          event.type === 'mode_advice' ||
          event.type === 'mode_downgrade_advised' ||
          event.type === 'task_started' ||
          event.type === 'task_tokens',
      )
      .filter(
        (event) =>
          event.message !== undefined || event.outcome === 'tight' || event.outcome === 'overflow',
      ),
  };
}

function latestWorkflowComplete(events: PacketEvent[]): string | null {
  return events.filter((event) => event.type === 'workflow_complete').at(-1)?.ts ?? null;
}

export function buildRun(
  opts: BuildReviewPacketOptions,
  events: PacketEvent[],
): ReviewPacket['run'] {
  return {
    sessionId: opts.sessionId,
    feature: opts.summary.feature,
    mode: opts.summary.mode ?? null,
    phase: opts.state.phase,
    planner: {
      tool: opts.summary.plannerTool ?? opts.state.plannerTool ?? null,
      model: opts.summary.plannerModel ?? opts.state.plannerModel ?? null,
    },
    implementer: {
      tool: opts.summary.implementerTool ?? opts.state.implementerTool ?? null,
      model: opts.summary.implementerModel ?? opts.state.implementerModel ?? null,
    },
    startedAt: opts.state.startedAt ?? null,
    completedAt: latestWorkflowComplete(events),
    totalTimeMs: opts.summary.totalTime,
    totalTasks: opts.summary.totalTasks,
    completedLocally: opts.summary.completedByLocal,
    escalated: opts.summary.escalatedToPlanner,
    skipped: opts.summary.skipped,
    failed: opts.summary.failed,
  };
}
