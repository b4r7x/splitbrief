import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Summary } from '../../core/schemas/summary.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { EvidenceLedger, EvidenceTask } from '../../core/schemas/evidence.js';
import { RECOVERY_ACTIONS, RECOVERY_REASONS, type RecoveryAction, type RecoveryReason } from '../../core/schemas/enums.js';
import type { ReviewPacket, ReviewPacketCheckpoint, ReviewPacketFinalReviewStatus } from '../../core/schemas/review-packet.js';
import { ReviewPacketSchema, REVIEW_PACKET_VERSION } from '../../core/schemas/review-packet.js';
import { TaskIdSchema, type Task, type TaskId } from '../../core/schemas/task.js';
import {
  BRIEF_QUALITY_FILE,
  DRIFT_CHAINS_FILE,
  DRIFT_REPORT_FILE,
  EVIDENCE_FILE,
  REVIEW_FILE,
  REVIEW_PACKET_JSON_FILE,
  REVIEW_PACKET_MARKDOWN_FILE,
  READINESS_FILE,
  SESSION_LOG_FILE,
  SNAPSHOTS_DIR,
  STATE_FILE,
  reviewPacketJsonPath,
  reviewPacketMarkdownPath,
  sessionDir,
} from '../../core/paths.js';
import { readEvents } from '../../core/sessions/log-reader.js';
import { writeSecureFile } from '../../lib/fs.js';
import { getChangedFiles } from '../../lib/git.js';
import { includes, narrowRecord } from '../../utils/type-guards.js';
import { readEvidenceLedger } from './evidence.js';
import { readDriftReport, type DriftFinding, type DriftReport } from './drift.js';
import { readDriftChainState } from './drift-chain-state.js';
import { CHECKPOINT_RESTORE_SAFETY, listCheckpointSummaries, type CheckpointSummary } from '../snapshots/checkpoint-summary.js';
import { readRunSnapshotLedger } from '../snapshots/run.js';

const RUN_LEDGER_PATH = `${SNAPSHOTS_DIR}/run-ledger.json`;
const REVIEW_EXCERPT_MAX = 500;

export const REVIEWER_CHECKLIST = [
  'Inspect changed files against the requested scope.',
  'Review drift findings and out-of-scope warnings.',
  'Confirm validation commands passed or understand failures.',
  'Check escalated, skipped, or retried tasks.',
  'Inspect expected vs observed evidence for each completed task.',
  'Run or review any project-specific tests not covered by diptych.',
  'Use `diptych snapshot diff SNAPSHOT_ID` before any restore.',
  'Use `diptych snapshot restore SNAPSHOT_ID` only after conflicts are understood.',
] as const;

type BuildReviewPacketOptions = {
  projectDir: string;
  sessionId: string;
  summary: Summary;
  state: WorkflowState;
  finalReviewStatus: 'written' | 'failed';
};

type BriefQualityArtifact = {
  version: 1;
  passed: boolean;
  score: number;
  issues: Array<{ severity: 'error' | 'warning'; message: string }>;
};

type PacketEvent = ReviewPacket['recoveryDecisions']['events'][number];
type RecoveryOutcome = ReviewPacket['recoveryDecisions']['outcomes'][number];
type RecoverySelectedAction = ReviewPacket['recoveryDecisions']['selectedActions'][number];
type MissingCollector = {
  missingArtifacts: string[];
  addMissing: (artifact: string) => void;
};

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function createMissingCollector(): MissingCollector {
  const missingArtifacts: string[] = [];
  return {
    missingArtifacts,
    addMissing: (artifact) => {
      if (!missingArtifacts.includes(artifact)) missingArtifacts.push(artifact);
    },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function recoveryReason(value: unknown): RecoveryReason | undefined {
  return includes(RECOVERY_REASONS, value) ? value : undefined;
}

function recoveryAction(value: unknown): RecoveryAction | undefined {
  return includes(RECOVERY_ACTIONS, value) ? value : undefined;
}

function recoveryActions(value: unknown): RecoveryAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions = value.filter((entry): entry is RecoveryAction => includes(RECOVERY_ACTIONS, entry));
  return actions.length > 0 ? actions : undefined;
}

function taskIds(value: unknown): TaskId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: TaskId[] = [];
  for (const entry of value) {
    const parsed = TaskIdSchema.safeParse(entry);
    if (parsed.success) ids.push(parsed.data);
  }
  return ids.length > 0 ? ids : undefined;
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((entry): entry is string => typeof entry === 'string');
  return values.length > 0 ? values : undefined;
}

function readJsonUnknown(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readBriefQuality(projectDir: string, sessionId: string, missing: MissingCollector): BriefQualityArtifact | null {
  const target = join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE);
  const raw = readJsonUnknown(target);
  if (raw === null) {
    missing.addMissing(BRIEF_QUALITY_FILE);
    return null;
  }

  const record = narrowRecord(raw);
  if (!record || record.version !== 1 || typeof record.passed !== 'boolean' || typeof record.score !== 'number') {
    missing.addMissing(BRIEF_QUALITY_FILE);
    return null;
  }

  const rawIssues = Array.isArray(record.issues) ? record.issues : [];
  const issues: BriefQualityArtifact['issues'] = [];
  for (const rawIssue of rawIssues) {
    const issue = narrowRecord(rawIssue);
    if (!issue) continue;
    const severity = issue.severity === 'error' || issue.severity === 'warning' ? issue.severity : undefined;
    const message = optionalString(issue.message);
    if (severity && message) issues.push({ severity, message });
  }

  return {
    version: 1,
    passed: record.passed,
    score: record.score,
    issues,
  };
}

function readReadiness(projectDir: string, sessionId: string, missing: MissingCollector): ReviewPacket['readiness'] {
  const target = join(sessionDir(projectDir, sessionId), READINESS_FILE);
  const raw = readJsonUnknown(target);
  if (raw === null) {
    missing.addMissing(READINESS_FILE);
    return {
      path: READINESS_FILE,
      present: false,
      status: null,
      nextAction: null,
      blockerCount: null,
      warningCount: null,
      checks: [],
    };
  }

  const record = narrowRecord(raw);
  if (!record || record.type !== 'start-readiness') {
    missing.addMissing(READINESS_FILE);
    return {
      path: READINESS_FILE,
      present: false,
      status: null,
      nextAction: null,
      blockerCount: null,
      warningCount: null,
      checks: [],
    };
  }

  return {
    path: READINESS_FILE,
    present: true,
    status: record.status === 'ready' || record.status === 'ready-with-warnings' || record.status === 'blocked'
      ? record.status
      : null,
    nextAction: recoveryReadinessAction(record.nextAction),
    blockerCount: nonnegativeIntegerOrNull(record.blockerCount),
    warningCount: nonnegativeIntegerOrNull(record.warningCount),
    checks: readinessChecks(record.checks),
  };
}

function nonnegativeIntegerOrNull(value: unknown): number | null {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0 ? value : null;
}

function recoveryReadinessAction(value: unknown): ReviewPacket['readiness']['nextAction'] {
  if (
    value === 'continue' ||
    value === 'run-init' ||
    value === 'fix-config' ||
    value === 'clean-or-isolate-repo' ||
    value === 'raise-context' ||
    value === 'set-budget' ||
    value === 'exit'
  ) {
    return value;
  }
  return null;
}

function readinessChecks(value: unknown): ReviewPacket['readiness']['checks'] {
  if (!Array.isArray(value)) return [];
  const checks: ReviewPacket['readiness']['checks'] = [];
  for (const rawCheck of value) {
    const check = narrowRecord(rawCheck);
    if (!check) continue;
    const id = optionalString(check.id);
    const summary = optionalString(check.summary);
    const severity = check.severity === 'ok' || check.severity === 'info' || check.severity === 'warning' || check.severity === 'blocker'
      ? check.severity
      : undefined;
    if (id && severity && summary) checks.push({ id, severity, summary });
  }
  return checks;
}

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
  return expectedEvidence.filter((expected) =>
    !observedEvidence.some((observed) => observed.includes(expected) || expected.includes(observed))
  );
}

async function readPacketEvents(projectDir: string, sessionId: string, missing: MissingCollector): Promise<PacketEvent[]> {
  const target = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
  if (!existsSync(target)) {
    missing.addMissing(SESSION_LOG_FILE);
    return [];
  }

  const events: PacketEvent[] = [];
  for await (const entry of readEvents(projectDir, sessionId)) {
    const data = narrowRecord(entry.data) ?? {};
    const reason = recoveryReason(data.reason);
    const action = recoveryAction(data.action);
    const files = strings(data.files);
    const affectedTaskIds = taskIds(data.affectedTaskIds);
    const availableActions = recoveryActions(data.availableActions);
    const recommendedAction = recoveryAction(data.recommendedAction);
    const message = optionalString(data.message)
      ?? optionalString(data.error)
      ?? optionalString(data.reason)
      ?? optionalString(data.routingReason);
    const outcome = optionalString(data.outcome) ?? optionalString(data.contextFit);
    const event: PacketEvent = {
      ts: entry.ts,
      type: entry.type,
      phase: entry.phase,
      ...(entry.taskId !== undefined && { taskId: entry.taskId }),
      ...(optionalString(data.issueId) !== undefined && { issueId: optionalString(data.issueId) }),
      ...(reason !== undefined && { reason }),
      ...(files !== undefined && { files }),
      ...(affectedTaskIds !== undefined && { affectedTaskIds }),
      ...(availableActions !== undefined && { availableActions }),
      ...(recommendedAction !== undefined && { recommendedAction }),
      ...(action !== undefined && { action }),
      ...(outcome !== undefined && { outcome }),
      ...(message !== undefined && { message }),
    };
    events.push(event);
  }
  return events;
}

async function readCheckpoints(
  projectDir: string,
  sessionId: string,
  missing: MissingCollector,
): Promise<ReviewPacket['checkpoints']> {
  let items: ReviewPacketCheckpoint[] = [];
  try {
    items = (await listCheckpointSummaries(projectDir, sessionId)).map(toReviewPacketCheckpoint);
  } catch {
    missing.addMissing(SNAPSHOTS_DIR);
  }

  const ledger = await readRunSnapshotLedger(projectDir, sessionId);
  if (!ledger) missing.addMissing(RUN_LEDGER_PATH);

  const latestRunCheckpointId = ledger?.runSnapshotIds.at(-1) ?? null;
  const latestRunCheckpoint = latestRunCheckpointId
    ? items.find((checkpoint) => checkpoint.id === latestRunCheckpointId) ?? null
    : null;
  const preFinalReview = items
    .filter((checkpoint) => checkpoint.kind === 'pre-final-review')
    .at(-1) ?? null;

  return {
    items,
    latestRunCheckpoint,
    preFinalReview,
    runLedger: {
      path: RUN_LEDGER_PATH,
      present: ledger !== null,
      accepted: ledger?.accepted ?? null,
      rejected: ledger?.rejected ?? null,
      runSnapshotIds: ledger?.runSnapshotIds ?? [],
      runSnapshotKinds: ledger?.runSnapshotKinds ?? {},
      latestSnapshotId: latestRunCheckpointId,
    },
  };
}

function toReviewPacketCheckpoint(checkpoint: CheckpointSummary): ReviewPacketCheckpoint {
  return {
    ...checkpoint,
    safety: {
      ...checkpoint.safety,
      excludedPaths: [...checkpoint.safety.excludedPaths],
      text: { ...checkpoint.safety.text },
    },
  };
}

async function resolveChangedFiles(
  projectDir: string,
  drift: DriftReport | null,
  missing: MissingCollector,
): Promise<string[]> {
  if (drift) return uniqueSorted(drift.changedFiles);
  try {
    return uniqueSorted(await getChangedFiles(projectDir));
  } catch {
    missing.addMissing('git status');
    return [];
  }
}

function groupDriftFindings(findings: DriftFinding[]): ReviewPacket['drift']['findingsBySeverity'] {
  return {
    info: findings.filter((finding) => finding.severity === 'info'),
    warning: findings.filter((finding) => finding.severity === 'warning'),
    error: findings.filter((finding) => finding.severity === 'error'),
  };
}

function buildChanges(
  state: WorkflowState,
  ledger: EvidenceLedger | null,
  drift: DriftReport | null,
  changedFiles: string[],
): ReviewPacket['changes'] {
  const expectedFiles = uniqueSorted(drift?.expectedFiles ?? state.tasks.map((task) => task.file).filter(Boolean));
  const outOfScopeFiles = uniqueSorted((drift?.findings ?? [])
    .filter((finding) => finding.code === 'out_of_scope_file' && finding.file)
    .map((finding) => finding.file ?? ''));
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
    diffReference: 'Review the working tree with `git diff`; full diffs are intentionally not embedded.',
  };
}

function buildValidation(state: WorkflowState, ledger: EvidenceLedger | null): ReviewPacket['validation'] {
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

  return {
    summary: ledger?.validationSummary ?? {
      passed: state.tasks.filter((task) => task.status === 'done').length,
      failed: state.tasks.filter((task) => task.status === 'failed').length,
      skipped: state.tasks.filter((task) => task.status === 'skipped').length,
      escalated: state.tasks.filter((task) => task.status === 'escalated').length,
    },
    tasks,
    finalReviewEvidenceStatus: ledger?.finalReview?.status ?? null,
    missingEvidenceWarnings: tasks.flatMap((task) =>
      task.missingExpectedEvidence.length > 0
        ? [`${task.taskId} missing expected evidence: ${task.missingExpectedEvidence.join(', ')}`]
        : []
    ),
  };
}

function buildEvidence(ledger: EvidenceLedger | null): ReviewPacket['evidence'] {
  return {
    path: ledger ? EVIDENCE_FILE : null,
    present: ledger !== null,
    briefHash: ledger?.briefHash ?? null,
    finalReview: ledger?.finalReview ?? null,
    approvals: ledger?.approvals ?? [],
    rejections: ledger?.rejections ?? [],
  };
}

function buildDrift(
  projectDir: string,
  sessionId: string,
  drift: DriftReport | null,
  briefQuality: BriefQualityArtifact | null,
): ReviewPacket['drift'] {
  const chainState = readDriftChainState(projectDir, sessionId);
  const topChain = chainState && chainState.emittedChains.length > 0
    ? chainState.emittedChains.reduce((best, chain) => best.score >= chain.score ? best : chain)
    : undefined;
  const findings = drift?.findings ?? [];
  return {
    path: drift ? DRIFT_REPORT_FILE : null,
    present: drift !== null,
    passed: drift?.passed ?? null,
    score: drift?.score ?? null,
    errorCount: findings.filter((finding) => finding.severity === 'error').length,
    warningCount: findings.filter((finding) => finding.severity === 'warning').length,
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
      errorCount: briefQuality?.issues.filter((issue) => issue.severity === 'error').length ?? 0,
      warningCount: briefQuality?.issues.filter((issue) => issue.severity === 'warning').length ?? 0,
    },
  };
}

function recoveryIssueSummary(state: WorkflowState): ReviewPacket['recoveryDecisions']['currentIssue'] {
  const issue = state.pendingRecovery;
  if (!issue) return null;
  return {
    issueId: issue.id,
    reason: issue.reason,
    status: issue.status,
    phase: issue.phase,
    ...(issue.taskId !== undefined && { taskId: issue.taskId }),
    ...(issue.selectedAction !== undefined && { selectedAction: issue.selectedAction }),
    recommendedAction: issue.recommendedAction,
    availableActions: issue.availableActions,
    files: issue.files,
    affectedTaskIds: issue.affectedTaskIds,
  };
}

function buildRecovery(state: WorkflowState, events: PacketEvent[], missing: MissingCollector): ReviewPacket['recoveryDecisions'] {
  const recoveryEvents = events.filter((event) => event.type.startsWith('recovery_'));
  const selectedActions: RecoverySelectedAction[] = recoveryEvents
    .filter((event) => event.type === 'recovery_action_selected' && event.issueId && event.reason && event.action)
    .map((event) => ({
      issueId: event.issueId ?? '',
      reason: event.reason ?? 'implementation-error',
      action: event.action ?? 'pause-run',
      selectedAt: event.ts,
    }));

  const resolvedOutcomes: RecoveryOutcome[] = recoveryEvents
    .filter((event) => event.type === 'recovery_resolved')
    .map((event) => {
      const outcome = event.outcome === 'skipped-current-task' ? 'skipped'
        : event.outcome === 'aborted' ? 'aborted'
          : event.outcome === 'continued' ? 'continued'
            : event.outcome === 'retry-current-task' ? 'retry-current-task'
              : 'unresolved';
      return {
        issueId: event.issueId ?? null,
        ...(event.action !== undefined && { action: event.action }),
        status: outcome,
      };
    });

  const failedOutcomes: RecoveryOutcome[] = recoveryEvents
    .filter((event) => event.type === 'recovery_action_failed')
    .map((event) => ({
      issueId: event.issueId ?? null,
      ...(event.action !== undefined && { action: event.action }),
      status: 'failed',
      ...(event.message !== undefined && { message: event.message }),
    }));

  const resolvedIssueIds = new Set(resolvedOutcomes.flatMap((outcome) => outcome.issueId ? [outcome.issueId] : []));
  const pausedOutcomes: RecoveryOutcome[] = selectedActions
    .filter((selected) => selected.action === 'pause-run' && !resolvedIssueIds.has(selected.issueId))
    .map((selected) => ({
      issueId: selected.issueId,
      action: selected.action,
      status: 'paused',
    }));

  const resumedOutcomes: RecoveryOutcome[] = events
    .filter((event) => event.type === 'workflow_resumed')
    .map(() => ({
      issueId: null,
      status: 'resumed',
    }));

  const currentIssue = recoveryIssueSummary(state);
  const unresolvedOutcomes: RecoveryOutcome[] = currentIssue
    ? [{
      issueId: currentIssue.issueId,
      ...(currentIssue.selectedAction !== undefined && { action: currentIssue.selectedAction }),
      status: 'unresolved',
      message: `${currentIssue.reason} recovery issue is still ${currentIssue.status}`,
    }]
    : [];

  const unresolvedRisks = [
    ...failedOutcomes.map((outcome) => `Recovery action failed${outcome.issueId ? ` for ${outcome.issueId}` : ''}${outcome.message ? `: ${outcome.message}` : ''}.`),
    ...pausedOutcomes.map((outcome) => `Recovery issue ${outcome.issueId ?? 'unknown'} paused without a resolved event.`),
    ...unresolvedOutcomes.map((outcome) => outcome.message ?? 'Recovery issue remains unresolved.'),
  ];

  if (missing.missingArtifacts.includes(SESSION_LOG_FILE)) {
    unresolvedRisks.push('Recovery events are unavailable because session.jsonl is missing.');
  }

  return {
    sourceArtifacts: [],
    events: recoveryEvents,
    currentIssue,
    selectedActions,
    outcomes: [...resolvedOutcomes, ...failedOutcomes, ...pausedOutcomes, ...resumedOutcomes, ...unresolvedOutcomes],
    unresolvedRisks,
  };
}

function makeRecoveryWithSources(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  events: PacketEvent[],
  ledger: EvidenceLedger | null,
  missing: MissingCollector,
): ReviewPacket['recoveryDecisions'] {
  const recovery = buildRecovery(state, events, missing);
  return {
    ...recovery,
    sourceArtifacts: [
      { path: STATE_FILE, present: existsSync(join(sessionDir(projectDir, sessionId), STATE_FILE)) },
      { path: SESSION_LOG_FILE, present: existsSync(join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE)) },
      { path: EVIDENCE_FILE, present: ledger !== null },
    ],
  };
}

function retryCountsFromEvents(events: PacketEvent[]): Map<TaskId, { retryCount: number; lastError: string | null }> {
  const retries = new Map<TaskId, { retryCount: number; lastError: string | null }>();
  for (const event of events) {
    if (event.type !== 'task_retry' || event.taskId === undefined) continue;
    const current = retries.get(event.taskId) ?? { retryCount: 0, lastError: null };
    retries.set(event.taskId, {
      retryCount: current.retryCount + 1,
      lastError: event.message ?? current.lastError,
    });
  }
  return retries;
}

function buildEscalations(state: WorkflowState, ledger: EvidenceLedger | null, events: PacketEvent[]): ReviewPacket['escalations'] {
  const retryMap = retryCountsFromEvents(events);
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
    if (event.type === 'task_skipped' && event.taskId !== undefined && event.message !== undefined) {
      skippedReasons.set(event.taskId, event.message);
    }
  }
  for (const entry of ledger?.tasks ?? []) {
    const reason = entry.observedEvidence.find((evidence) => evidence.startsWith('skipped: '));
    if (entry.status === 'skipped' && reason) skippedReasons.set(entry.id, reason.slice('skipped: '.length));
  }

  return {
    retries: [...retryMap.entries()]
      .map(([taskIdValue, retry]) => ({ taskId: taskIdValue, ...retry }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId)),
    escalatedTasks: state.tasks
      .filter((task) => task.status === 'escalated' || taskEvidence(task, ledger)?.escalated === true)
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
    warnings: events.filter((event) =>
      event.type === 'warning' ||
      event.type === 'budget_warning' ||
      event.type === 'budget_paused' ||
      event.type === 'budget_exceeded'
    ),
  };
}

function buildCost(summary: Summary, events: PacketEvent[]): ReviewPacket['cost'] {
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
        ...(summary.costBreakdown.hasPricedUsage !== undefined && { hasPricedUsage: summary.costBreakdown.hasPricedUsage }),
        ...(summary.costBreakdown.hasUnpricedUsage !== undefined && { hasUnpricedUsage: summary.costBreakdown.hasUnpricedUsage }),
        ...(summary.costBreakdown.hasSavingsEstimate !== undefined && { hasSavingsEstimate: summary.costBreakdown.hasSavingsEstimate }),
      }
      : null,
    estimatedCostSavings: summary.costBreakdown?.hasSavingsEstimate === false
      ? null
      : summary.estimatedCostSavings,
    taskRouting: summary.taskBreakdown ?? [],
    routingWarnings: events.filter((event) =>
      event.type === 'mode_advice' ||
      event.type === 'mode_downgrade_advised' ||
      event.type === 'task_started' ||
      event.type === 'task_tokens'
    ).filter((event) => event.message !== undefined || event.outcome === 'tight' || event.outcome === 'overflow'),
  };
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 4);
  return end === -1 ? text : text.slice(end + 5);
}

function reviewExcerpt(projectDir: string, sessionId: string): string | null {
  const target = join(sessionDir(projectDir, sessionId), REVIEW_FILE);
  if (!existsSync(target)) return null;
  const normalized = stripFrontmatter(readFileSync(target, 'utf8')).replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return null;
  if (normalized.length <= REVIEW_EXCERPT_MAX) return normalized;
  return `${normalized.slice(0, REVIEW_EXCERPT_MAX - 3)}...`;
}

function buildFinalReview(
  projectDir: string,
  sessionId: string,
  requestedStatus: 'written' | 'failed',
  ledger: EvidenceLedger | null,
  missing: MissingCollector,
): ReviewPacket['finalReview'] {
  const target = join(sessionDir(projectDir, sessionId), REVIEW_FILE);
  const exists = existsSync(target);
  if (!exists) missing.addMissing(REVIEW_FILE);
  const status: ReviewPacketFinalReviewStatus = requestedStatus === 'failed'
    ? 'failed'
    : exists
      ? 'written'
      : 'missing';
  const statusText = status === 'written'
    ? `Planner final review written to ${REVIEW_FILE}.`
    : status === 'failed'
      ? `Planner final review failed; ${REVIEW_FILE} may be absent.`
      : `${REVIEW_FILE} was not available.`;
  return {
    path: REVIEW_FILE,
    status,
    evidenceStatus: ledger?.finalReview?.status ?? null,
    statusText,
    excerpt: reviewExcerpt(projectDir, sessionId),
  };
}

function sourceArtifactMissing(projectDir: string, sessionId: string, missing: MissingCollector): void {
  if (!existsSync(join(sessionDir(projectDir, sessionId), STATE_FILE))) missing.addMissing(STATE_FILE);
}

function latestWorkflowComplete(events: PacketEvent[]): string | null {
  return events.filter((event) => event.type === 'workflow_complete').at(-1)?.ts ?? null;
}

function buildRun(
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

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  const record = narrowRecord(value);
  if (!record) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = sortJson(record[key]);
  }
  return sorted;
}

export function stringifyReviewPacket(packet: ReviewPacket): string {
  return `${JSON.stringify(sortJson(packet), null, 2)}\n`;
}

function renderList(items: string[]): string {
  if (items.length === 0) return '- None recorded.';
  return items.map((item) => `- ${item}`).join('\n');
}

function renderReadinessChecks(checks: ReviewPacket['readiness']['checks']): string[] {
  if (checks.length === 0) return ['- Checks: unavailable'];
  return checks.map((check) => `- ${check.severity} ${check.id}: ${check.summary}`);
}

function formatStatus(status: boolean | null): string {
  if (status === true) return 'passed';
  if (status === false) return 'failed';
  return 'unavailable';
}

function formatCheckpointKind(checkpoint: ReviewPacketCheckpoint): string {
  return checkpoint.inferredKind
    ? `${checkpoint.kind} (inferred ${checkpoint.inferredKind})`
    : checkpoint.kind;
}

export function renderReviewPacketMarkdown(packet: ReviewPacket): string {
  const restoreSafety = packet.checkpoints.items[0]?.safety ?? CHECKPOINT_RESTORE_SAFETY;
  const checkpointLines = packet.checkpoints.items.length === 0
    ? ['- No checkpoints available.']
    : packet.checkpoints.items.map((checkpoint) =>
      `- ${checkpoint.id}${checkpoint.name ? ` (${checkpoint.name})` : ''}: ${formatCheckpointKind(checkpoint)}, ${checkpoint.trackedFileCount} files, diff \`${checkpoint.diffCommand}\`, restore \`${checkpoint.restoreCommand}\``
    );
  const driftLines = packet.drift.findings.length === 0
    ? ['- No drift findings recorded.']
    : packet.drift.findings.map((finding) => `- [${finding.severity}] ${finding.code}: ${finding.message}`);
  const recoveryLines = packet.recoveryDecisions.outcomes.length === 0
    ? ['- No recovery decisions recorded.']
    : packet.recoveryDecisions.outcomes.map((outcome) =>
      `- ${outcome.status}${outcome.action ? ` via ${outcome.action}` : ''}${outcome.issueId ? ` (${outcome.issueId})` : ''}${outcome.message ? `: ${outcome.message}` : ''}`
    );
  const taskValidationLines = packet.validation.tasks.map((task) =>
    `- ${task.taskId} ${task.status}: ${task.validation.filter((entry) => entry.passed).length}/${task.validation.length} validation stages passed`
  );

  return [
    '# Review Packet',
    '',
    '## Run Header',
    `- Session: ${packet.sessionId}`,
    `- Feature: ${packet.run.feature}`,
    `- Mode: ${packet.run.mode ?? 'n/a'}`,
    `- Planner: ${packet.run.planner.tool ?? 'n/a'}${packet.run.planner.model ? ` (${packet.run.planner.model})` : ''}`,
    `- Implementer: ${packet.run.implementer.tool ?? 'n/a'}${packet.run.implementer.model ? ` (${packet.run.implementer.model})` : ''}`,
    `- Tasks: ${packet.run.totalTasks} total, ${packet.run.completedLocally} local, ${packet.run.escalated} escalated, ${packet.run.skipped} skipped, ${packet.run.failed} failed`,
    `- Generated: ${packet.generatedAt}`,
    '',
    '## Readiness',
    `- Artifact: ${packet.readiness.present ? packet.readiness.path : 'missing'}`,
    `- Status: ${packet.readiness.status ?? 'unavailable'}`,
    `- Next action: ${packet.readiness.nextAction ?? 'unavailable'}`,
    `- Blockers: ${packet.readiness.blockerCount ?? 'unavailable'}`,
    `- Warnings: ${packet.readiness.warningCount ?? 'unavailable'}`,
    ...renderReadinessChecks(packet.readiness.checks),
    '',
    '## Change Summary',
    renderList(packet.changes.changedFiles),
    `- Expected files: ${packet.changes.expectedFiles.length}`,
    `- Out-of-scope files: ${packet.changes.outOfScopeFiles.length}`,
    `- Diff: ${packet.changes.diffReference}`,
    '',
    '## Checkpoints And Restore',
    ...checkpointLines,
    `- Latest run checkpoint: ${packet.checkpoints.latestRunCheckpoint?.id ?? 'none'}`,
    `- Pre-final-review checkpoint: ${packet.checkpoints.preFinalReview?.id ?? 'none'}`,
    `- Restore safety: ${restoreSafety.text.hashGuarded}`,
    `- Restore safety: ${restoreSafety.text.conflictsSkippedByDefault}`,
    `- Restore safety: ${restoreSafety.text.forceOverwritesConflicts}`,
    `- Restore safety: ${restoreSafety.text.partialRestoreExpected}`,
    `- Restore safety: ${restoreSafety.text.excludedPaths}`,
    `- Excluded paths: ${restoreSafety.excludedPaths.join(', ')}`,
    '',
    '## Validation And Evidence',
    `- Validation: ${packet.validation.summary.passed} passed, ${packet.validation.summary.failed} failed, ${packet.validation.summary.skipped} skipped, ${packet.validation.summary.escalated} escalated`,
    `- Evidence ledger: ${packet.evidence.present ? packet.evidence.path : 'missing'}`,
    ...taskValidationLines,
    '',
    '## Drift And Scope',
    `- Drift: ${formatStatus(packet.drift.passed)}${packet.drift.score === null ? '' : `, score ${packet.drift.score.toFixed(2)}`}`,
    ...driftLines,
    '',
    '## Escalations, Retries, Skips, And Warnings',
    `- Retries: ${packet.escalations.retries.length}`,
    `- Escalated tasks: ${packet.escalations.escalatedTasks.length}`,
    `- Skipped tasks: ${packet.escalations.skippedTasks.length}`,
    `- Failed tasks: ${packet.escalations.failedTasks.length}`,
    `- Warnings: ${packet.escalations.warnings.length}`,
    '',
    '## Recovery Decisions',
    ...recoveryLines,
    ...packet.recoveryDecisions.unresolvedRisks.map((risk) => `- Risk: ${risk}`),
    '',
    '## Cost And Routing',
    `- Actual cost: ${packet.cost.costBreakdown ? `$${packet.cost.costBreakdown.totalActualCost.toFixed(4)}` : 'unavailable'}`,
    `- Estimated savings: ${packet.cost.estimatedCostSavings ?? 'unavailable'}`,
    `- Per-task routing entries: ${packet.cost.taskRouting.length}`,
    '',
    '## Planner Final Review',
    `- Status: ${packet.finalReview.status}`,
    `- Path: ${packet.finalReview.path}`,
    `- ${packet.finalReview.statusText}`,
    ...(packet.finalReview.excerpt ? [`- Excerpt: ${packet.finalReview.excerpt}`] : []),
    '',
    '## Human Reviewer Checklist',
    ...packet.reviewerChecklist.map((item) => `- [ ] ${item}`),
    '',
    '## Missing Artifacts',
    renderList(packet.missingArtifacts),
    '',
  ].join('\n');
}

export async function buildReviewPacket(opts: BuildReviewPacketOptions): Promise<ReviewPacket> {
  const missing = createMissingCollector();
  sourceArtifactMissing(opts.projectDir, opts.sessionId, missing);

  const ledger = readEvidenceLedger(opts.projectDir, opts.sessionId);
  if (!ledger) missing.addMissing(EVIDENCE_FILE);

  const drift = readDriftReport(opts.projectDir, opts.sessionId);
  if (!drift) missing.addMissing(DRIFT_REPORT_FILE);

  if (!existsSync(join(sessionDir(opts.projectDir, opts.sessionId), DRIFT_CHAINS_FILE))) missing.addMissing(DRIFT_CHAINS_FILE);
  const briefQuality = readBriefQuality(opts.projectDir, opts.sessionId, missing);
  const readiness = readReadiness(opts.projectDir, opts.sessionId, missing);
  const events = await readPacketEvents(opts.projectDir, opts.sessionId, missing);
  const changedFiles = await resolveChangedFiles(opts.projectDir, drift, missing);
  const checkpoints = await readCheckpoints(opts.projectDir, opts.sessionId, missing);
  const finalReview = buildFinalReview(opts.projectDir, opts.sessionId, opts.finalReviewStatus, ledger, missing);

  const packet: ReviewPacket = {
    version: REVIEW_PACKET_VERSION,
    sessionId: opts.sessionId,
    generatedAt: new Date().toISOString(),
    run: buildRun(opts, events),
    readiness,
    changes: buildChanges(opts.state, ledger, drift, changedFiles),
    checkpoints,
    recoveryDecisions: makeRecoveryWithSources(opts.projectDir, opts.sessionId, opts.state, events, ledger, missing),
    validation: buildValidation(opts.state, ledger),
    evidence: buildEvidence(ledger),
    drift: buildDrift(opts.projectDir, opts.sessionId, drift, briefQuality),
    escalations: buildEscalations(opts.state, ledger, events),
    cost: buildCost(opts.summary, events),
    finalReview,
    reviewerChecklist: [...REVIEWER_CHECKLIST],
    missingArtifacts: [...missing.missingArtifacts].sort((a, b) => a.localeCompare(b)),
  };

  return ReviewPacketSchema.parse(packet);
}

export async function writeReviewPacket(opts: BuildReviewPacketOptions): Promise<ReviewPacket> {
  const packet = await buildReviewPacket(opts);
  writeSecureFile(reviewPacketJsonPath(opts.projectDir, opts.sessionId), stringifyReviewPacket(packet));
  writeSecureFile(reviewPacketMarkdownPath(opts.projectDir, opts.sessionId), renderReviewPacketMarkdown(packet));
  return packet;
}

export const REVIEW_PACKET_ARTIFACTS = {
  json: REVIEW_PACKET_JSON_FILE,
  markdown: REVIEW_PACKET_MARKDOWN_FILE,
} as const;
