import type { StateAuthorityReceipt } from '../../../core/state/types.js';
import { loadStateForResume } from '../../../core/state/resume-authority.js';
import { BRIEF_QUALITY_FILE, TASKS_FILE } from '../../../core/paths.js';
import { readSpecFile } from '../../../core/paths-io.js';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery/document.js';
import {
  type BriefQualityIssue,
  BriefQualityIssueSchema,
} from '../../../core/schemas/brief-recovery/primitives.js';
import {
  sameExecutionPermit,
  sameGeneration,
  type BriefGenerationRef,
  type TaskExecutionPermit,
} from '../../../core/schemas/brief-owner.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { narrowRecord } from '../../../utils/type-guards.js';
import { evaluateBriefQuality } from '../../spec/brief-quality.js';
import { parseTasksStrict } from '../../spec/tasks/parse.js';
import { fallbackBriefRecoveryProjection } from './brief-quality-queue.js';
import { briefGenerationRefFor } from './brief-generation-ref.js';
import type { PlanningPhaseResult } from './types.js';

type ReadyPlanningPhaseResult = Extract<PlanningPhaseResult, { disposition: 'ready-for-tasks' }>;

function taskIdentity(task: Task): Omit<Task, 'status' | 'currentCode'> {
  const { status: _status, currentCode: _currentCode, ...identity } = task;
  return identity;
}

function sameTaskIdentity(left: readonly Task[], right: readonly Task[]): boolean {
  return (
    left.length === right.length &&
    sha256Hex(JSON.stringify(left.map(taskIdentity))) ===
      sha256Hex(JSON.stringify(right.map(taskIdentity)))
  );
}

function persistedReadyParts(
  state: WorkflowState,
): Readonly<{ generation: BriefGenerationRef; permit: TaskExecutionPermit }> | null {
  const generation = state.generation;
  const permit = state.permit;
  const recovery = state.briefRecovery;
  if (
    (state.phase !== 'implementing' && state.phase !== 'final-review') ||
    generation === undefined ||
    generation === null ||
    permit === undefined ||
    permit === null ||
    state.authorityRevision === undefined ||
    recovery === undefined ||
    recovery === null ||
    recovery.status !== 'ready'
  ) {
    return null;
  }
  if (
    permit.authorityRevision !== state.authorityRevision ||
    permit.epochId !== recovery.epochId ||
    permit.generationId !== generation.generationId ||
    permit.manifestDigest !== generation.manifestDigest ||
    permit.tasksDigest !== generation.tasksDigest ||
    permit.qualityDigest !== generation.qualityDigest
  ) {
    return null;
  }
  return { generation, permit };
}

export function matchesPersistedExecutionPermit(
  result: ReadyPlanningPhaseResult,
  state: WorkflowState,
): boolean {
  const persisted = persistedReadyParts(state);
  const resultPersisted = persistedReadyParts(result.state);
  return (
    persisted !== null &&
    resultPersisted !== null &&
    result.state.phase === state.phase &&
    result.state.stateRevision === state.stateRevision &&
    result.state.authorityRevision === state.authorityRevision &&
    result.state.stateFence?.token === state.stateFence?.token &&
    result.state.stateFence?.ownerId === state.stateFence?.ownerId &&
    sameTaskIdentity(result.tasks, state.tasks) &&
    sameGeneration(resultPersisted.generation, persisted.generation) &&
    sameExecutionPermit(resultPersisted.permit, persisted.permit) &&
    sameGeneration(result.generation, persisted.generation) &&
    sameExecutionPermit(result.permit, persisted.permit)
  );
}

type PersistedPermitRecheck = Readonly<{
  state: WorkflowState;
  planning: ReadyPlanningPhaseResult;
}>;

type QualityArtifact = Readonly<{
  briefHash: string;
  passed: boolean;
  score: number;
  issues: readonly BriefQualityIssue[];
  ruleVersion: string;
}>;

function sameQualityIssues(
  left: readonly BriefQualityIssue[],
  right: readonly BriefQualityIssue[],
): boolean {
  return (
    left.length === right.length &&
    left.every((issue, index) => {
      const expected = right[index];
      return (
        expected !== undefined &&
        issue.code === expected.code &&
        issue.severity === expected.severity &&
        issue.taskId === expected.taskId &&
        issue.message === expected.message
      );
    })
  );
}

function readAuthoritativeState(
  ref: SessionRef,
  authority: StateAuthorityReceipt,
): WorkflowState | null {
  try {
    const loaded = loadStateForResume({
      ref,
      authority: { kind: 'fenced', receipt: authority, promotedFromVersion: null },
    });
    return loaded.kind === 'loaded' ? loaded.state : null;
  } catch {
    return null;
  }
}

function parseQualityArtifact(text: string): QualityArtifact | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const record = narrowRecord(value);
  if (
    record === null ||
    record.version !== 1 ||
    record.passed !== true ||
    typeof record.briefHash !== 'string' ||
    typeof record.score !== 'number' ||
    !Number.isFinite(record.score) ||
    record.score < 0 ||
    record.score > 1 ||
    typeof record.ruleVersion !== 'string'
  ) {
    return null;
  }
  const issues = BriefQualityIssueSchema.array().safeParse(record.issues);
  if (!issues.success) return null;
  return {
    briefHash: record.briefHash,
    passed: record.passed,
    score: record.score,
    issues: issues.data,
    ruleVersion: record.ruleVersion,
  };
}

function qualityArtifactMatches(
  qualityText: string,
  tasks: readonly Task[],
  tasksBytesDigest: string,
): QualityArtifact | null {
  const report = parseQualityArtifact(qualityText);
  if (
    report === null ||
    report.briefHash !== tasksBytesDigest ||
    report.ruleVersion !== 'brief-quality-v1'
  ) {
    return null;
  }
  const expected = evaluateBriefQuality([...tasks]);
  const expectedIssues = BriefQualityIssueSchema.array().safeParse(expected.issues);
  if (
    !expectedIssues.success ||
    report.passed !== expected.passed ||
    report.score !== expected.score ||
    !sameQualityIssues(report.issues, expectedIssues.data)
  ) {
    return null;
  }
  return report;
}

/**
 * Re-read the owner head and its persisted Brief artifacts at the task boundary.
 * The caller's planning result is only a proposal; the persisted head and bytes
 * are the authority used to decide whether the implementer may run.
 */
export function revalidatePersistedExecutionPermit(opts: {
  ref: SessionRef;
  state: WorkflowState;
  planning: PlanningPhaseResult;
  authority: StateAuthorityReceipt;
}): PersistedPermitRecheck | null {
  if (
    opts.planning.disposition !== 'ready-for-tasks' ||
    !matchesPersistedExecutionPermit(opts.planning, opts.state)
  ) {
    return null;
  }

  const persistedState = readAuthoritativeState(opts.ref, opts.authority);
  if (persistedState === null || !matchesPersistedExecutionPermit(opts.planning, persistedState)) {
    return null;
  }

  let tasksText: string | null;
  let qualityText: string | null;
  try {
    tasksText = readSpecFile(opts.ref, TASKS_FILE);
    qualityText = readSpecFile(opts.ref, BRIEF_QUALITY_FILE);
  } catch {
    return null;
  }
  if (tasksText === null || qualityText === null) return null;

  let persistedTasks: Task[];
  try {
    persistedTasks = parseTasksStrict(tasksText);
  } catch {
    return null;
  }
  const tasksBytesDigest = sha256Hex(tasksText);
  const qualityDigest = sha256Hex(qualityText);
  const quality = qualityArtifactMatches(qualityText, persistedTasks, tasksBytesDigest);
  if (quality === null) return null;

  const generation = persistedState.generation;
  const permit = persistedState.permit;
  const recovery = persistedState.briefRecovery;
  if (
    generation === undefined ||
    generation === null ||
    permit === undefined ||
    permit === null ||
    recovery === undefined ||
    recovery === null ||
    recovery.status !== 'ready' ||
    recovery.matchingReport === null
  ) {
    return null;
  }

  const matchingIssues = BriefQualityIssueSchema.array().safeParse(recovery.matchingReport.issues);
  const actualGeneration = briefGenerationRefFor({
    epochId: recovery.epochId,
    tasks: persistedTasks,
    qualityDigest,
  });
  if (
    !matchingIssues.success ||
    !sameGeneration(generation, actualGeneration) ||
    !sameTaskIdentity(persistedTasks, persistedState.tasks) ||
    !sameTaskIdentity(persistedTasks, opts.planning.tasks) ||
    recovery.activeBrief.hash !== tasksBytesDigest ||
    recovery.matchingReport.briefHash !== tasksBytesDigest ||
    recovery.matchingReport.report.hash !== qualityDigest ||
    recovery.matchingReport.ruleVersion !== quality.ruleVersion ||
    !sameQualityIssues(matchingIssues.data, quality.issues) ||
    permit.approvalEvidence.revision !== 1 ||
    permit.approvalEvidence.hash !== qualityDigest ||
    recovery.matchingReport.report.path !== permit.approvalEvidence.path
  ) {
    return null;
  }

  const planning: ReadyPlanningPhaseResult = {
    disposition: 'ready-for-tasks',
    state: persistedState,
    generation,
    tasks: persistedTasks,
    permit,
  };
  return matchesPersistedExecutionPermit(planning, persistedState)
    ? { state: persistedState, planning }
    : null;
}

export function parkedPlanningResult(
  sessionId: string,
  state: WorkflowState,
  projection?: BriefRecoveryProjectionV1,
): Extract<PlanningPhaseResult, { disposition: 'parked' }> {
  return {
    disposition: 'parked',
    state,
    projection: projection ?? fallbackBriefRecoveryProjection(sessionId, state),
  };
}

export function terminalPlanningResult(
  state: WorkflowState,
  outcome: Extract<PlanningPhaseResult, { disposition: 'terminal' }>['outcome'],
): Extract<PlanningPhaseResult, { disposition: 'terminal' }> {
  return { disposition: 'terminal', state, outcome };
}

export function planningResultForState(opts: {
  sessionId: string;
  state: WorkflowState;
  projection?: BriefRecoveryProjectionV1;
  tasks?: readonly Task[];
}): PlanningPhaseResult {
  const persisted = persistedReadyParts(opts.state);
  if (persisted !== null) {
    return {
      disposition: 'ready-for-tasks',
      state: opts.state,
      generation: persisted.generation,
      tasks: opts.tasks ?? opts.state.tasks,
      permit: persisted.permit,
    };
  }
  if (opts.state.phase === 'idle' && opts.state.briefRecovery?.status === 'rejected') {
    return { disposition: 'terminal', state: opts.state, outcome: 'rejected' };
  }
  return parkedPlanningResult(opts.sessionId, opts.state, opts.projection);
}

export function withPlanningResultState(
  result: PlanningPhaseResult,
  state: WorkflowState,
): PlanningPhaseResult {
  return { ...result, state };
}
