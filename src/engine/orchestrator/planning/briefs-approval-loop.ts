import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery/document.js';
import type {
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
import { driftedCompilerReceipt } from '../../runners/compiler-drift-warning.js';
import { recordRuntimeConformance } from '../../runners/runtime-conformance-cache.js';
import { briefGenerationRefFor } from './brief-generation-ref.js';
import type { BriefsApprovalLoopOptions, BriefsApprovalLoopResult } from './types.js';
import { readWorkflowStateHead, transitionAndSave } from '../state-ops.js';
import { persistBriefOwnerTransition } from '../evidence/brief-owner-journal.js';
import { issueApprovedGenerationPermit } from './briefs-approval-queue.js';
import { readPersistedTasks } from './io.js';
import { writeAndPublishArtifacts } from '../artifact-write.js';
import {
  formatBriefReadinessBlocks,
  runBriefReadinessGateAndReport,
} from './brief-readiness-gate.js';
import { recoveryResultFromProjection, runBriefReviewExit } from './brief-review-gate.js';
import { buildTargetedRejectionComment } from './regen-targeted.js';
import {
  type ApprovalDecision,
  editCommand,
  initialCursor,
  isApprovalDecision,
  isEditDecision,
  isNormalRecovery,
  isRetryDecision,
  isRevisionDecision,
  queueCommand,
  rejectionCommand,
  retryCommand,
  updateCursor,
} from './brief-recovery-commands.js';

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

const MAX_NO_PROGRESS_ATTEMPTS = 20;

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
