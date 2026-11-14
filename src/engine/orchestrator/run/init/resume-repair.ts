import { hashTaskBrief } from '../../../../core/evidence/brief-hash.js';
import { readEvidenceLedger } from '../../../../core/evidence/ledger-storage.js';
import { isImplementerPhase, isLivePhase } from '../../../../core/phases/roles.js';
import { isRetiredRecoveryReason } from '../../../../core/recovery/halt.js';
import { stepReadsNoWords } from '../../../../core/recovery/typed-words.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import { isTaskCompleted, isTaskSettled } from '../../../../core/schemas/task.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { resumeStep } from '../../../../core/sessions/run/status.js';
import { sessionConversation } from '../../../../core/state/planning-conversation.js';
import type { SessionRef } from '../../../../core/types/session-ref.js';
import type { UserMessageInput } from '../../../../core/types/user-input.js';
import type { EventBus } from '../../../events/types.js';
import { type ContinuationHolder, createContinuationHolder } from '../../continuation/holder.js';
import { readInterruptedPartial, readUnresumedBriefCut } from '../../continuation/interrupted.js';
import { recordSteer } from '../../continuation/loop.js';
import { publishRecoveryResolved } from '../../publish/recovery.js';
import { publishInfo } from '../../publish/notice.js';
import { publishDebug } from '../../publish/notice.js';
import { runCodeDir } from '../../kept-work.js';
import { transitionAndSave } from '../../state-ops/transition.js';
import { restoreInterruptedTaskFiles } from '../../task/rollback.js';

/**
 * The words that restart a run are the user turn they are: recorded once in the
 * transcript and the session log. Not when the planning session has a question
 * still pending — the steer is that question's answer, and the session records it
 * when it consumes the seed. An older chain's question is earlier planning, so the
 * steer is a turn of its own.
 */
export function publishResumedSteer(input: {
  bus: EventBus;
  projectDir: string;
  sessionId: string;
  state: WorkflowState | undefined;
  steer: UserMessageInput | undefined;
}): void {
  const { bus, projectDir, sessionId, state } = input;
  const steer = input.steer;
  if (state === undefined || steer === undefined || steer.text.trim() === '') return;
  if (sessionConversation(state)?.answered === false) return;
  recordSteer({ bus, projectDir, sessionId }, state.phase, steer);
}

/**
 * What this run was continued with. The step the stop recorded owns it, so the
 * partial a cut attempt left reaches that step and no other; a run continued
 * without a recorded park, or parked at a step that reads no words, seeds the
 * steer at the step it picks up under the REVIEW of this pass.
 */
export async function resumeContinuation(input: {
  ref: SessionRef;
  state: WorkflowState | undefined;
  steer: UserMessageInput | undefined;
  reviewNone: boolean;
}): Promise<ContinuationHolder> {
  const { ref, state, steer } = input;
  if (state === undefined) return createContinuationHolder();
  const interrupted = state.interruptedStep;
  const task = state.tasks[state.currentTaskIndex];
  const cutBrief =
    interrupted?.cut === 'mid-step' && interrupted.step.kind === 'brief'
      ? interrupted.step
      : undefined;
  const parkedBrief =
    state.closed === undefined &&
    state.rewindPending === undefined &&
    isImplementerPhase(state.phase) &&
    cutBrief !== undefined &&
    task?.id === cutBrief.taskId;
  // A brief parked at its consult continues there, also after Try again reset its attempt.
  const consult = parkedBrief ? interrupted?.consult : undefined;
  const keepWorkspace =
    parkedBrief &&
    consult === undefined &&
    task.status === 'in_progress' &&
    state.attempt === cutBrief.attempt;
  const owner =
    interrupted !== undefined && !stepReadsNoWords(interrupted.step, input.reviewNone)
      ? interrupted
      : undefined;
  // A boundary park cut nothing, and a cold crash flushed nothing it can name.
  const partial =
    owner !== undefined &&
    owner.cut !== 'boundary' &&
    (owner.step.kind !== 'brief' || keepWorkspace)
      ? await readInterruptedPartial(ref)
      : undefined;
  if (partial === undefined && steer === undefined && !keepWorkspace && consult === undefined)
    return createContinuationHolder();
  return createContinuationHolder({
    step: owner === undefined ? resumeStep(state, input.reviewNone) : owner.step,
    ...(partial !== undefined && { partial }),
    ...(steer !== undefined && { steer }),
    ...(keepWorkspace && { keepWorkspace: true, briefFingerprint: hashTaskBrief([task]) }),
    ...(consult !== undefined && { consult }),
  });
}

/**
 * A halt on a retired cause is always stale: nothing the run still checks raised it. A
 * checkout-changed halt that names only HEAD and branch moves is stale only when the run has no
 * saved workspace. Other halts still stand.
 */
function isStaleHalt(issue: RecoveryIssue, state: WorkflowState): boolean {
  if (isRetiredRecoveryReason(issue.reason)) return true;
  if (issue.reason !== 'checkout-changed' || state.workspace !== undefined) return false;
  const changes = issue.message.split(' — ').at(-1)?.split(' · ') ?? [];
  return changes.every((change) => change === 'HEAD' || change.startsWith('branch '));
}

/** A pending halt on re-entry that is stale; the entry resolves it. */
export function hasStaleHalt(state: WorkflowState): boolean {
  return state.pendingRecovery !== undefined && isStaleHalt(state.pendingRecovery, state);
}

/** The entry that acts on it: a stale halt is over and the run continues. */
export async function settleStaleHalt(args: {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
}): Promise<WorkflowState> {
  const { projectDir, sessionId, bus, state } = args;
  const issue = state.pendingRecovery;
  if (issue === undefined || !isStaleHalt(issue, state)) return state;

  const resolved = transitionAndSave(
    { projectDir, sessionId },
    state,
    { type: 'RESOLVE_PENDING_RECOVERY' },
    { expectedRevision: state.stateRevision },
  );
  publishRecoveryResolved({
    bus,
    phase: resolved.phase,
    issue,
    action: 'continue',
    outcome: 'continued',
  });
  publishDebug({
    bus,
    phase: resolved.phase,
    message: 'The halt this run saved no longer applies; continuing.',
    safety: { category: 'recovery', code: 'stale_file_halt_resolved' },
  });
  return resolved;
}

/**
 * A run written before the task index followed skipped briefs can point at a brief that already
 * passed while another one ran. The brief that ran is the one to continue: the first in progress,
 * else the first not settled. The next save persists the corrected index and cut step.
 */
export function realignPassedTaskIndex(bus: EventBus, state: WorkflowState): WorkflowState {
  if (!isImplementerPhase(state.phase)) return state;
  const stale = state.tasks[state.currentTaskIndex];
  if (stale === undefined || !isTaskCompleted(stale.status)) return state;
  const inProgress = state.tasks.findIndex((t) => t.status === 'in_progress');
  const index =
    inProgress >= 0 ? inProgress : state.tasks.findIndex((t) => !isTaskSettled(t.status));
  const task = state.tasks[index];
  if (task === undefined) return state;
  const cut = state.interruptedStep;
  publishDebug({
    bus,
    phase: state.phase,
    message: `The saved run pointed at ${stale.id}, which already passed; continuing at ${task.id}.`,
  });
  return {
    ...state,
    currentTaskIndex: index,
    ...(cut?.step.kind === 'brief' &&
      cut.step.taskId === stale.id && {
        interruptedStep: { ...cut, step: { ...cut.step, taskId: task.id } },
      }),
  };
}

/**
 * Re-entry clears a cut brief's park before the brief runs again (`runPlanningPhases`). A halt
 * raised in between, then a stop, leaves the brief `in_progress` with no park, which the crash check
 * below would restart at attempt 0. The log still holds the cut and no call has started since, so
 * the park is put back: the brief continues at its cut attempt, in its kept workspace, and its
 * recorded writes stay its own.
 */
export async function restoreUnresumedBriefCut(args: {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
}): Promise<WorkflowState> {
  const { projectDir, sessionId, bus, state } = args;
  if (
    state.interruptedStep !== undefined ||
    state.closed !== undefined ||
    state.rewindPending !== undefined ||
    !isImplementerPhase(state.phase)
  )
    return state;
  const cut = await readUnresumedBriefCut({ projectDir, sessionId });
  if (cut === undefined || state.tasks[state.currentTaskIndex]?.id !== cut.step.taskId)
    return state;
  const restored = transitionAndSave(
    { projectDir, sessionId },
    state,
    { type: 'RESTORE_BRIEF_PARK', ...cut },
    { expectedRevision: state.stateRevision },
  );
  publishInfo({
    bus,
    phase: restored.phase,
    message: `${cut.step.taskId} continues where the stop left it.`,
  });
  return restored;
}

/**
 * A brief no runner is executing any more. Validating and escalating say so by
 * their phase; `implementing` needs the task's own status, because that is also
 * the phase of a brief the operator parked on purpose — and a park keeps its
 * partial edits and continues with context rather than restarting clean.
 */
export function isTaskInFlight(state: WorkflowState): boolean {
  if (state.interruptedStep?.cut === 'mid-step' && state.interruptedStep.step.kind === 'brief')
    return false;
  if (state.phase === 'validating-task' || state.phase === 'escalating') return true;
  if (state.phase !== 'implementing' || state.interruptedStep !== undefined) return false;
  return state.tasks[state.currentTaskIndex]?.status === 'in_progress';
}

/**
 * A session killed while its brief was running left half-written files behind and
 * a state that points at a task no runner is executing. The brief's own declared
 * files restart from its task-start snapshot, so the resumed run re-enters at the
 * brief's start instead of on top of an abandoned attempt.
 */
export async function restartInterruptedTask(args: {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
}): Promise<WorkflowState> {
  const { projectDir, sessionId, bus, state } = args;
  const task = state.tasks[state.currentTaskIndex];
  if (task === undefined) return state;
  const snapshot = state.changedFilesBaseline?.activeTaskSnapshot;
  // Older runs recorded partial promotion without parking recovery. Its target
  // writes and later user edits are already authoritative; restart on top of a
  // fresh acquisition instead of restoring the abandoned pre-task snapshot.
  const priorPromotion = readEvidenceLedger({ projectDir, sessionId })?.tasks.find(
    (entry) => entry.id === task.id,
  )?.promotionAttempts?.length;
  if (snapshot !== undefined && !priorPromotion) {
    await restoreInterruptedTaskFiles({
      wctx: { projectDir, workspaceDir: runCodeDir(projectDir, state.workspace), sessionId, bus },
      phase: state.phase,
      task,
      taskStartSnapshot: snapshot,
    });
  }
  return transitionAndSave(
    { projectDir, sessionId },
    state,
    { type: 'RESET_TASK', taskId: task.id },
    { expectedRevision: state.stateRevision },
  );
}

export function shouldPublishResumePlannerStatus(state: WorkflowState): boolean {
  return (
    isLivePhase(state.phase) && !isImplementerPhase(state.phase) && state.phase !== 'final-review'
  );
}
