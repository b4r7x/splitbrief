import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { ApprovalReviewResult } from '../../../core/approval/types.js';
import type {
  BriefRecoveryProjectionV1,
  NormalBriefRecoveryV1,
} from '../../../core/schemas/brief-recovery/document.js';
import type {
  BriefRecoveryCommand,
  BriefRecoveryController,
  QueueBriefInput,
  QueueResultV1,
  RecoveryResultV1,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { EventBus } from '../../events/types.js';
import { publishError, publishWarning } from '../events.js';
import { BRIEF_QUALITY_FILE, TASKS_FILE, sessionDir } from '../../../core/paths.js';
import { readSpecFile } from '../../../core/paths-io.js';
import { readSessionFileConfined } from '../../../core/sessions/confinement.js';
import { parseTasksStrict } from '../../spec/tasks/parse.js';
import { formatTasks } from '../../spec/formatter.js';
import { error, matches } from '../../../utils/error.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { driftedCompilerReceipt } from '../../runners/compiler-drift-warning.js';
import { recordRuntimeConformance } from '../../runners/runtime-conformance-cache.js';
import { briefGenerationRefFor } from './brief-generation-ref.js';
import type { BriefsApprovalLoopOptions, BriefsApprovalLoopResult } from './types.js';
import { readWorkflowStateHead, transitionAndSave } from '../state-ops.js';
import { persistBriefOwnerTransition } from '../evidence/recovery-journal.js';
import { issueApprovedGenerationPermit } from './briefs-approval-queue.js';
import { readPersistedTasks } from './io.js';
import { writeAndPublishArtifacts } from '../artifact-write.js';
import {
  formatBriefReadinessBlocks,
  runBriefReadinessGateAndReport,
} from './brief-readiness-gate.js';
import { recoveryResultFromProjection, runBriefReviewExit } from './brief-review-gate.js';
import { buildTargetedRejectionComment } from './regen-targeted.js';

export type BriefsApprovalRecoveryBinding = {
  controller: Pick<BriefRecoveryController, 'dispatchBriefAction' | 'queueBriefInput'>;
  authority: StateAuthorityReceipt;
  source?: QueueBriefInput['source'] | undefined;
  operationId?: string | null | undefined;
  projection?: BriefRecoveryProjectionV1 | undefined;
  admission?: RecoveryResultV1 | undefined;
  nextInputSequence?: number | undefined;
  readState?: (() => WorkflowState) | undefined;
  writeState?: ((state: WorkflowState) => void) | undefined;
};

export type ApprovalLoopOptions = BriefsApprovalLoopOptions & {
  recovery?: BriefsApprovalRecoveryBinding | undefined;
};

type RecoveryCursor = {
  authority: StateAuthorityReceipt;
  projection: BriefRecoveryProjectionV1 | undefined;
  epochId: string | null;
  base: BriefRecoveryProjectionV1['activeBrief'];
  activeOperationId: string | null;
  inputIds: readonly string[];
  nextInputSequence: number;
};

type RetryReviewResult = {
  approved: false;
  action: 'retry';
  operationId?: string | undefined;
  intentHash?: string | undefined;
};

type ApprovalDecision = ApprovalReviewResult | RetryReviewResult;

const MAX_NO_PROGRESS_ATTEMPTS = 20;

function isNormalRecovery(
  recovery: WorkflowState['briefRecovery'],
): recovery is NormalBriefRecoveryV1 {
  return (
    recovery !== undefined &&
    recovery !== null &&
    recovery.status !== 'storage-blocked' &&
    recovery.status !== 'rejected'
  );
}

function initialCursor(
  state: WorkflowState,
  recovery: BriefsApprovalRecoveryBinding,
): RecoveryCursor {
  const normal = isNormalRecovery(state.briefRecovery) ? state.briefRecovery : null;
  const projection = recovery.projection;
  return {
    authority: recovery.authority,
    projection,
    epochId: projection?.epochId ?? normal?.epochId ?? null,
    base: projection?.activeBrief ?? normal?.activeBrief ?? null,
    activeOperationId:
      projection?.activeOperation?.operationId ??
      normal?.activeOperationId ??
      recovery.operationId ??
      null,
    inputIds:
      normal === null
        ? (projection?.queuedInputs.ids ?? [])
        : normal.inputs
            .filter((input) => input.state === 'queued' || input.state === 'carried')
            .map((input) => input.inputId),
    nextInputSequence: recovery.nextInputSequence ?? normal?.nextInputSequence ?? 1,
  };
}

function semanticProjectionFingerprint(projection: BriefRecoveryProjectionV1): string {
  return JSON.stringify({
    status: projection.status,
    blocker: projection.blocker,
    activeBrief:
      projection.activeBrief === null
        ? null
        : { hash: projection.activeBrief.hash, path: projection.activeBrief.path },
    matchingReport:
      projection.matchingReport === null
        ? null
        : {
            briefHash: projection.matchingReport.briefHash,
            report: {
              hash: projection.matchingReport.report.hash,
              path: projection.matchingReport.report.path,
            },
            ruleVersion: projection.matchingReport.ruleVersion,
            issues: projection.matchingReport.issues,
          },
    queuedInputState: {
      carriedCount: projection.queuedInputs.carriedCount,
      heldCount: projection.queuedInputs.heldCount,
      releasedCount: projection.queuedInputs.releasedCount,
    },
    allowedActions: projection.allowedActions,
  });
}

function updateCursor(
  cursor: RecoveryCursor,
  result: RecoveryResultV1 | QueueResultV1,
  inputIds: readonly string[],
  authority: StateAuthorityReceipt,
): boolean {
  const previous = cursor.projection;
  cursor.authority = {
    ...cursor.authority,
    ...authority,
    stateRevision: result.projection.stateRevision,
  };
  cursor.projection = result.projection;
  cursor.epochId = result.projection.epochId;
  cursor.base = result.projection.activeBrief;
  cursor.activeOperationId = result.projection.activeOperation?.operationId ?? null;
  cursor.inputIds = inputIds;
  if (result.kind === 'accepted' && 'input' in result) cursor.nextInputSequence += 1;
  return (
    previous === undefined ||
    semanticProjectionFingerprint(previous) !== semanticProjectionFingerprint(result.projection)
  );
}

function commandBase(cursor: RecoveryCursor): {
  epochId: string;
  base: NonNullable<RecoveryCursor['base']>;
} | null {
  if (cursor.epochId === null || cursor.base === null) return null;
  return { epochId: cursor.epochId, base: cursor.base };
}

function resultKeepsReview(result: RecoveryResultV1): boolean {
  return result.kind !== 'ready' && result.kind !== 'rejected';
}

function resultSummary(result: RecoveryResultV1): string {
  if ('reason' in result && result.reason !== undefined) return result.reason;
  if (result.kind === 'blocked') return result.code;
  return `Brief recovery action returned ${result.kind}.`;
}

function publishRefusal(bus: EventBus, state: WorkflowState, result: RecoveryResultV1): void {
  publishWarning({
    bus,
    phase: state.phase,
    message: `Task Brief recovery remains in review: ${resultSummary(result)}`,
    safety: { category: 'workflow', code: 'brief_recovery_blocked', transcriptSafe: true },
  });
}

function publishClientFailure(bus: EventBus, state: WorkflowState): void {
  publishWarning({
    bus,
    phase: state.phase,
    message: 'Task Brief recovery controller is unavailable; review remains open.',
    safety: { category: 'workflow', code: 'brief_recovery_unavailable', transcriptSafe: true },
  });
}

function publishNoProgressFailure(bus: EventBus, state: WorkflowState): void {
  publishError({
    bus,
    phase: state.phase,
    message: `Task Brief review made no progress after ${MAX_NO_PROGRESS_ATTEMPTS} attempts; review remains open.`,
    safety: { category: 'workflow', code: 'brief_review_no_progress', transcriptSafe: true },
  });
}

function publishReadinessBlock(
  bus: EventBus,
  state: WorkflowState,
  report: Awaited<ReturnType<typeof runBriefReadinessGateAndReport>>,
): void {
  publishWarning({
    bus,
    phase: state.phase,
    message: `${formatBriefReadinessBlocks(report)} Approve again without editing tasks.md to proceed anyway.`,
    safety: { category: 'workflow', code: 'brief_readiness_blocked', transcriptSafe: true },
  });
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  if (typeof value !== 'object' || value === null) return false;
  if (!('approved' in value) || typeof value.approved !== 'boolean') return false;
  if (value.approved) return true;
  const action = 'action' in value ? value.action : undefined;
  if (action === undefined || action === 'edit' || action === 'retry') return true;
  return action === 'revise' && 'comment' in value && typeof value.comment === 'string';
}

function retryCommand(
  cursor: RecoveryCursor,
  result: RetryReviewResult,
  feedbackInputIds?: readonly string[],
): BriefRecoveryCommand | null {
  const identity = commandBase(cursor);
  if (identity === null) return null;
  const diagnostic = sha256Hex(
    JSON.stringify(
      cursor.projection?.blocker ?? { status: cursor.projection?.status ?? 'blocked' },
    ),
  );
  const operationId = result.operationId ?? `retry-${randomUUID()}`;
  const frozenInputIds = feedbackInputIds ?? cursor.inputIds;
  const intentHash =
    result.intentHash ??
    sha256Hex(
      `${operationId}:${identity.base.hash}:${diagnostic}:${feedbackInputIds === undefined ? 'retry' : 'feedback-revision'}:${frozenInputIds.join(',')}`,
    );
  return {
    version: 1,
    sessionId: cursor.authority.sessionId,
    epochId: identity.epochId,
    operationId,
    base: identity.base,
    intentHash,
    action: 'retry',
    diagnosticFingerprint: diagnostic,
    frozenInputIds,
    ...(feedbackInputIds === undefined ? {} : { attemptKind: 'feedback-revision' as const }),
  };
}

function rejectionCommand(
  cursor: RecoveryCursor,
): Extract<BriefRecoveryCommand, { action: 'reject' }> | null {
  const identity = commandBase(cursor);
  if (identity === null) return null;
  return {
    version: 1,
    sessionId: cursor.authority.sessionId,
    epochId: identity.epochId,
    operationId: `reject-${randomUUID()}`,
    base: identity.base,
    intentHash: sha256Hex(`reject:${identity.base.hash}`),
    action: 'reject',
    userIntentId: randomUUID(),
  };
}

function editCommand(
  cursor: RecoveryCursor,
  briefText: string,
  inputId: string,
): Extract<BriefRecoveryCommand, { action: 'edit' }> | null {
  const identity = commandBase(cursor);
  if (identity === null) return null;
  return {
    version: 1,
    sessionId: cursor.authority.sessionId,
    epochId: identity.epochId,
    operationId: `edit-${inputId}`,
    base: identity.base,
    intentHash: sha256Hex(`edit:${identity.base.hash}:${briefText}`),
    action: 'edit',
    briefText,
    newInputId: inputId,
  };
}

function queueCommand(
  cursor: RecoveryCursor,
  payload: string,
  source: QueueBriefInput['source'],
  inputId: string,
): QueueBriefInput | null {
  const identity = commandBase(cursor);
  if (identity === null || payload.length === 0) return null;
  return {
    sessionId: cursor.authority.sessionId,
    epochId: identity.epochId,
    inputId,
    sequence: cursor.nextInputSequence,
    kind: 'feedback',
    source,
    payload,
    base: identity.base,
    operationId: cursor.activeOperationId,
  };
}

function isRetryDecision(result: ApprovalDecision): result is RetryReviewResult {
  return !result.approved && 'action' in result && result.action === 'retry';
}

function isEditDecision(
  result: ApprovalDecision,
): result is Extract<ApprovalReviewResult, { action: 'edit' }> {
  return !result.approved && 'action' in result && result.action === 'edit';
}

function isRevisionDecision(
  result: ApprovalDecision,
): result is Extract<ApprovalReviewResult, { action: 'revise' }> {
  return !result.approved && 'action' in result && result.action === 'revise';
}

async function readEditedBrief(projectDir: string, sessionId: string): Promise<string | null> {
  const tasksFilePath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
  return readSessionFileConfined(dirname(tasksFilePath), tasksFilePath);
}

function parseBriefText(text: string): Task[] | null {
  try {
    return parseTasksStrict(text);
  } catch {
    return null;
  }
}

export async function runBriefsApprovalLoop(
  opts: ApprovalLoopOptions,
): Promise<BriefsApprovalLoopResult> {
  const recovery = opts.recovery;
  if (recovery === undefined) {
    publishClientFailure(opts.bus, opts.state);
    return { state: opts.state, tasks: opts.tasks, rejected: false, outcome: 'failed' };
  }

  const tasksFilePath = join(sessionDir(opts.projectDir, opts.sessionId), TASKS_FILE);
  let state = opts.state;
  let tasks = opts.tasks;
  const cursor = initialCursor(state, recovery);
  const refreshAuthority = (): void => {
    try {
      const head = readWorkflowStateHead({
        projectDir: opts.projectDir,
        sessionId: opts.sessionId,
      });
      if (head !== null) {
        recovery.authority = {
          ...recovery.authority,
          stateRevision: head.state.stateRevision ?? 0,
          stateDigest: head.digest,
        };
      }
    } catch {
      // The controller remains the authority when the local refresh cannot read the head.
    }
  };
  let noProgressAttempts = 0;
  const applyRecoveryResult = (result: RecoveryResultV1 | QueueResultV1): boolean => {
    refreshAuthority();
    const currentRecovery = recovery.readState?.()?.briefRecovery;
    const inputIds = isNormalRecovery(currentRecovery)
      ? currentRecovery.inputs
          .filter((input) => input.state === 'queued' || input.state === 'carried')
          .map((input) => input.inputId)
      : result.projection.queuedInputs.ids;
    noProgressAttempts = updateCursor(cursor, result, inputIds, recovery.authority)
      ? 0
      : noProgressAttempts + 1;
    return noProgressAttempts < MAX_NO_PROGRESS_ATTEMPTS;
  };
  const rejectBriefs = (): BriefsApprovalLoopResult => {
    try {
      const current = recovery.readState?.() ?? state;
      // The controller may already have reset the workflow to idle/rejected;
      // do not apply REJECT_BRIEFS twice to that terminal head.
      if (current.phase === 'idle' && current.briefRecovery?.status === 'rejected') {
        state = current;
        tasks = state.tasks;
        return { state, tasks, rejected: true, outcome: 'rejected' };
      }
      state = transitionAndSave(
        { projectDir: opts.projectDir, sessionId: opts.sessionId },
        current,
        { type: 'REJECT_BRIEFS' },
      );
      recovery.writeState?.(state);
      tasks = state.tasks;
      return { state, tasks, rejected: true, outcome: 'rejected' };
    } catch {
      publishClientFailure(opts.bus, state);
      return { state, tasks, rejected: false, outcome: 'failed' };
    }
  };
  const failNoProgress = (): BriefsApprovalLoopResult => {
    publishNoProgressFailure(opts.bus, state);
    return rejectBriefs();
  };

  while (true) {
    if (opts.signal?.aborted)
      return { state, tasks, rejected: false, outcome: 'aborted', aborted: true };
    let result: ApprovalDecision;
    try {
      const decision = await opts.callbacks.onApprovalNeeded('briefs', tasksFilePath);
      if (!isApprovalDecision(decision)) {
        publishClientFailure(opts.bus, state);
        return { state, tasks, rejected: false, outcome: 'failed' };
      }
      result = decision;
    } catch {
      publishClientFailure(opts.bus, state);
      return { state, tasks, rejected: false, outcome: 'failed' };
    }
    if (opts.signal?.aborted)
      return { state, tasks, rejected: false, outcome: 'aborted', aborted: true };

    if (isRetryDecision(result)) {
      const command = retryCommand(cursor, result);
      if (command === null) {
        publishClientFailure(opts.bus, state);
        return { state, tasks, rejected: false, outcome: 'failed' };
      }
      let recoveryResult: RecoveryResultV1;
      try {
        recoveryResult = await recovery.controller.dispatchBriefAction(command, cursor.authority);
      } catch {
        publishClientFailure(opts.bus, state);
        return { state, tasks, rejected: false, outcome: 'failed' };
      }
      if (!applyRecoveryResult(recoveryResult)) return failNoProgress();
      if (recoveryResult.kind === 'ready')
        return { state, tasks, rejected: false, outcome: 'accepted' };
      publishRefusal(opts.bus, state, recoveryResult);
      continue;
    }

    if (isEditDecision(result)) {
      const briefText = await readEditedBrief(opts.projectDir, opts.sessionId);
      const editedBrief = briefText === null ? null : parseBriefText(briefText);
      const command = briefText === null ? null : editCommand(cursor, briefText, randomUUID());
      if (command === null) {
        publishClientFailure(opts.bus, state);
        return { state, tasks, rejected: false, outcome: 'failed' };
      }
      let recoveryResult: RecoveryResultV1;
      try {
        recoveryResult = await recovery.controller.dispatchBriefAction(command, cursor.authority);
      } catch {
        publishClientFailure(opts.bus, state);
        return { state, tasks, rejected: false, outcome: 'failed' };
      }
      if (!applyRecoveryResult(recoveryResult)) return failNoProgress();
      recovery.admission = recoveryResult;
      if (recoveryResult.kind === 'ready') {
        if (editedBrief !== null) {
          tasks = editedBrief;
          const readiness = await runBriefReadinessGateAndReport({
            tasks,
            config: opts.config,
            projectDir: opts.projectDir,
            sessionId: opts.sessionId,
            bus: opts.bus,
            phase: state.phase,
            ...(opts.modelCache === undefined ? {} : { modelCache: opts.modelCache }),
            ...(opts.detectedContextLength === undefined
              ? {}
              : { detectedContextLength: opts.detectedContextLength }),
          });
          if (!readiness.ok) publishReadinessBlock(opts.bus, state, readiness);
        }
      }
      if (resultKeepsReview(recoveryResult)) publishRefusal(opts.bus, state, recoveryResult);
      continue;
    }

    if (isRevisionDecision(result)) {
      let payload = result.comment;
      if (result.taskIds !== undefined && result.taskIds.length > 0) {
        const persisted = await readPersistedTasks(tasksFilePath);
        const persistedTasks = persisted.ok ? persisted.tasks : null;
        if (persistedTasks === null) {
          publishWarning({
            bus: opts.bus,
            phase: state.phase,
            message: 'Targeted revision requires valid Task Briefs in tasks.md.',
            safety: {
              category: 'workflow',
              code: 'brief_revision_tasks_invalid',
              transcriptSafe: true,
            },
          });
          continue;
        }
        const tasksById = new Map(persistedTasks.map((task) => [task.id, task]));
        const unknown = result.taskIds.find((taskId) => !tasksById.has(taskId));
        if (unknown !== undefined) {
          publishError({
            bus: opts.bus,
            phase: state.phase,
            message: `Unknown Task Brief ID for targeted revision: ${unknown}`,
            safety: {
              category: 'workflow',
              code: 'brief_revision_unknown_task',
              transcriptSafe: true,
            },
          });
          continue;
        }
        payload = buildTargetedRejectionComment(
          result.taskIds
            .map((taskId) => tasksById.get(taskId))
            .filter((task): task is Task => task !== undefined),
          result.comment,
        );
      }
      const inputId = randomUUID();
      const input = queueCommand(cursor, payload, recovery.source ?? 'interactive', inputId);
      if (input === null) {
        publishClientFailure(opts.bus, state);
        return { state, tasks, rejected: false, outcome: 'failed' };
      }
      let queueResult: QueueResultV1;
      try {
        queueResult = await recovery.controller.queueBriefInput(input, cursor.authority);
      } catch {
        publishClientFailure(opts.bus, state);
        return { state, tasks, rejected: false, outcome: 'failed' };
      }
      if (!applyRecoveryResult(queueResult)) return failNoProgress();
      if (queueResult.kind !== 'accepted' && queueResult.kind !== 'replayed') {
        publishWarning({
          bus: opts.bus,
          phase: state.phase,
          message: `Task Brief feedback remains queued for review: ${queueResult.reason}`,
          safety: {
            category: 'workflow',
            code: 'brief_recovery_input_refused',
            transcriptSafe: true,
          },
        });
        continue;
      }
      const command = retryCommand(cursor, { approved: false, action: 'retry' }, [inputId]);
      if (command === null) {
        publishClientFailure(opts.bus, state);
        return { state, tasks, rejected: false, outcome: 'failed' };
      }
      let recoveryResult: RecoveryResultV1;
      try {
        recoveryResult = await recovery.controller.dispatchBriefAction(command, cursor.authority);
      } catch {
        publishClientFailure(opts.bus, state);
        return { state, tasks, rejected: false, outcome: 'failed' };
      }
      if (!applyRecoveryResult(recoveryResult)) return failNoProgress();
      recovery.admission = recoveryResult;
      if (recoveryResult.kind === 'ready') {
        const revised = await readPersistedTasks(tasksFilePath);
        if (revised.ok) tasks = revised.tasks;
      }
      if (resultKeepsReview(recoveryResult)) publishRefusal(opts.bus, state, recoveryResult);
      continue;
    }

    if (result.approved) {
      const projection = cursor.projection;
      const activeBrief = projection?.activeBrief;
      const matchingReport = projection?.matchingReport;
      const continuation = projection?.continuation;
      const reportBytes = readSpecFile(
        { projectDir: opts.projectDir, sessionId: opts.sessionId },
        BRIEF_QUALITY_FILE,
      );
      if (
        projection === undefined ||
        activeBrief === null ||
        activeBrief === undefined ||
        matchingReport === null ||
        matchingReport === undefined ||
        continuation === null ||
        continuation === undefined
      ) {
        publishClientFailure(opts.bus, state);
        return { state, tasks, rejected: false, outcome: 'failed' };
      }
      // The fixed tasks.md is the user-edit input surface, never execution
      // authority: its bytes are proven against the admitted brief hash, and
      // a missing file falls back to the current-call owned candidate.
      const editedText = await readSessionFileConfined(dirname(tasksFilePath), tasksFilePath);
      const parsedEdited =
        editedText === null || editedText.trim() === '' ? null : parseBriefText(editedText);
      const reviewTasks = parsedEdited ?? tasks;
      const briefBytes = editedText === null ? formatTasks(tasks) : editedText;
      const currentRecovery = (recovery.readState?.() ?? state).briefRecovery;
      const readinessDecision = isNormalRecovery(currentRecovery)
        ? currentRecovery.readinessDecision
        : undefined;
      let outcome: Awaited<ReturnType<typeof runBriefReviewExit>>;
      try {
        outcome = await runBriefReviewExit({
          controller: recovery.controller,
          authority: cursor.authority,
          admission: recovery.admission ?? recoveryResultFromProjection(projection),
          proof: {
            sessionId: cursor.authority.sessionId,
            epochId: cursor.epochId ?? '',
            operationId: `approve-${randomUUID()}`,
            brief: activeBrief,
            report: matchingReport.report,
            briefBytes,
            reportBytes,
            qualityPolicyVersion: matchingReport.ruleVersion,
            stateRevision: cursor.authority.stateRevision,
            fence: cursor.authority.fence,
            continuation,
          },
          tasks: reviewTasks,
          readiness: () =>
            runBriefReadinessGateAndReport({
              tasks: reviewTasks,
              config: opts.config,
              projectDir: opts.projectDir,
              sessionId: opts.sessionId,
              bus: opts.bus,
              phase: state.phase,
              ...(opts.modelCache === undefined ? {} : { modelCache: opts.modelCache }),
              ...(opts.detectedContextLength === undefined
                ? {}
                : { detectedContextLength: opts.detectedContextLength }),
            }),
          ...(readinessDecision === undefined ? {} : { readinessDecision }),
          recordReadinessDecision: (decision) => {
            const current = recovery.readState?.() ?? state;
            state = transitionAndSave(
              { projectDir: opts.projectDir, sessionId: opts.sessionId },
              current,
              { type: 'RECORD_BRIEF_READINESS', decision },
            );
            recovery.writeState?.(state);
            const recorded = state.briefRecovery;
            if (!isNormalRecovery(recorded) || cursor.projection === undefined) {
              return recoveryResultFromProjection(projection);
            }
            return recoveryResultFromProjection({
              ...cursor.projection,
              stateRevision: state.stateRevision ?? cursor.projection.stateRevision,
              recoveryRevision: recorded.recoveryRevision,
              status: recorded.status,
            });
          },
          materialize: async (input) => {
            const current = recovery.readState?.() ?? state;
            const currentRecovery = current.briefRecovery;
            const approvedReport =
              isNormalRecovery(currentRecovery) && currentRecovery.status === 'ready'
                ? currentRecovery.matchingReport
                : null;
            const epochId = cursor.epochId;
            if (approvedReport === null || epochId === null) {
              throw error(
                'brief-materialization-invalid',
                'approval materialization requires ready recovery authority',
              );
            }
            const qualityDigest = approvedReport.report.hash;
            const generation = briefGenerationRefFor({
              epochId,
              tasks: input.tasks,
              qualityDigest,
            });
            const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
            const head = readWorkflowStateHead(ref);
            const issued = issueApprovedGenerationPermit({
              ref,
              epochId,
              authorityRevision: head?.state.authorityRevision ?? 0,
              generation,
              qualityDigest,
              commit: (commitInput) =>
                persistBriefOwnerTransition({ ...commitInput, ref, bus: opts.bus }),
            });
            if (issued.kind !== 'issued') {
              publishWarning({
                bus: opts.bus,
                phase: state.phase,
                message: `The approved Task Briefs could not receive their execution permit: ${issued.reason}.`,
                safety: {
                  category: 'workflow',
                  code: 'brief_permit_refused',
                  transcriptSafe: true,
                },
              });
              throw error(
                'brief-permit-refused',
                `the approval permit could not be issued: ${issued.reason}`,
                { reason: issued.reason },
              );
            }
            // Compatibility projections refresh only after the authoritative
            // generation commit, so they can never authorize another Brief.
            // The fixed tasks.md must carry the exact proof-verified bytes
            // without a fresh metadata frontmatter: the admitted brief hash
            // binds the raw bytes, and any added or re-serialized bytes would
            // break the persisted-permit revalidation at the task boundary.
            writeAndPublishArtifacts({
              projectDir: opts.projectDir,
              sessionId: opts.sessionId,
              bus: opts.bus,
              phase: current.phase,
              metadata: null,
              generation,
              items: [{ kind: 'task-briefs', text: briefBytes }],
            });
            state = transitionAndSave(
              ref,
              { ...(readWorkflowStateHead(ref)?.state ?? current), tasks: [...input.tasks] },
              {
                type: 'BEGIN_IMPLEMENTATION',
                generation,
                permit: issued.permit,
              },
            );
            recovery.writeState?.(state);
            // The owner settlement is the one path every owner-bound mode
            // takes, so a runtime that carried Briefs through to implementation
            // records its conformance here and the drift warning stays silent
            // for that exact (backend, runtime version) pair.
            const receipt = driftedCompilerReceipt(opts.planner);
            if (receipt !== null) {
              recordRuntimeConformance(opts.projectDir, {
                backend: receipt.backend,
                version: receipt.runtimeVersion,
              });
            }
          },
        });
      } catch (err) {
        if (!matches('brief-permit-refused')(err)) publishClientFailure(opts.bus, state);
        return { state, tasks, rejected: false, outcome: 'failed' };
      }
      if (!applyRecoveryResult(outcome.recovery)) return failNoProgress();
      recovery.admission = outcome.recovery;
      if (outcome.kind === 'materialized') {
        tasks = reviewTasks;
        return { state, tasks, rejected: false, outcome: 'accepted' };
      }
      if (outcome.kind === 'readiness-blocked') {
        publishReadinessBlock(opts.bus, state, outcome.readiness);
      }
      publishRefusal(opts.bus, state, outcome.recovery);
      continue;
    }
    const command = rejectionCommand(cursor);
    if (command === null) {
      publishClientFailure(opts.bus, state);
      return { state, tasks, rejected: false, outcome: 'failed' };
    }
    let recoveryResult: RecoveryResultV1;
    try {
      recoveryResult = await recovery.controller.dispatchBriefAction(command, cursor.authority);
    } catch {
      publishClientFailure(opts.bus, state);
      return { state, tasks, rejected: false, outcome: 'failed' };
    }
    if (!applyRecoveryResult(recoveryResult)) return failNoProgress();
    if (recoveryResult.kind === 'rejected') {
      return rejectBriefs();
    }
    publishRefusal(opts.bus, state, recoveryResult);
  }
}
