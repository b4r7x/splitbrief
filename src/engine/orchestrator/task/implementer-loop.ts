import { briefContinuation, changedDeclaredFiles, changedDeclaredFilesNote } from '../kept-work.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { lineageAttemptsOf } from '../../../core/state/lineage.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import type { WorkflowPersistenceContext } from '../types.js';
import type { ImplementerOptions, ImplementerResult } from '../../implementers/types.js';
import type { ImplementerLoopInput, ImplementerLoopState } from './types.js';
import { withContinuationLoop, type ContinuationLoopBodyArgs } from '../continuation/loop.js';
import { approveWrite } from './gates/write.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { implementerSeatAttempt, runSeatCall } from '../escalation/seat/call.js';
import { unfinishedGuidance } from '../escalation/consult-guidance.js';
import { addUsageAndSave } from '../state-ops/usage.js';
import { recordedApiCreatedPaths } from '../evidence/target-writes.js';
import {
  absorbBuildCorrections,
  buildCorrectionInput,
  recordSteerCorrection,
  runWithCorrectionPasses,
} from '../queue/build-corrections.js';
import { settleMidCallDeliveries } from '../queue/mid-call.js';
import { withAttemptRestoreScope } from './restore-scope.js';

/** Records a steer as a correction of the brief, once for each message. */
export function recordCorrection(
  input: Pick<ImplementerLoopInput, 'wctx' | 'task' | 'setTrackedState'>,
  shared: ImplementerLoopState,
  message: UserMessageInput | undefined,
): void {
  if (message === undefined || message === shared.recordedCorrection) return;
  shared.state = recordSteerCorrection({
    ...input.wctx,
    state: shared.state,
    taskId: input.task.id,
    message,
  });
  shared.recordedCorrection = message;
  input.setTrackedState(shared.state);
}

/** Runs the implementer calls of one brief, again after each stop that continues the brief. */
export function runImplementerLoop(
  input: ImplementerLoopInput,
  shared: ImplementerLoopState,
): Promise<{ state: WorkflowState; value: ImplementerResult }> {
  const { wctx, workspace } = input;
  const { projectDir, sessionId } = wctx;
  return withContinuationLoop<ImplementerResult>({
    ctx: {
      projectDir: workspace.projectDir,
      sessionId,
      persistRef: { projectDir, sessionId },
      callbacks: wctx.callbacks,
      bus: wctx.bus,
      signal: wctx.signal,
      sinks: wctx.sinks,
    },
    state: shared.state,
    step: input.step,
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    onStateChange: input.setTrackedState,
    body: (args) => runAttempt(input, shared, args),
  });
}

async function runAttempt(
  input: ImplementerLoopInput,
  shared: ImplementerLoopState,
  { signal, partial, steerInput, recordOutput }: ContinuationLoopBodyArgs,
): Promise<ImplementerResult> {
  // The brief restarts on its own prompt. What the cut attempt already
  // wrote is still on disk, so it is named rather than re-derived.
  recordCorrection(input, shared, steerInput);
  const { wctx, task, workspace } = input;
  const { projectDir, sessionId, config } = wctx;
  const call = implementerCall(input, shared, signal, recordOutput);
  const seatRef = { projectDir, sessionId, bus: wctx.bus };
  const attempt = await withAttemptRestoreScope({
    ref: wctx,
    dir: workspace.projectDir,
    taskStartSnapshot: input.taskStartSnapshot,
    attemptSnapshot: workspace.snapshot,
    run: () =>
      runSeatCall(
        {
          ref: seatRef,
          state: shared.state,
          seat: 'build',
          runner: config.implementer,
          config,
          profile: wctx.implementerProfile,
          signal,
          onStateChange: (next) => {
            shared.state = next;
            input.setTrackedState(next);
          },
        },
        async (attemptSignal) =>
          implementerSeatAttempt(
            await produce(input, shared, { call, partial, seatRef }, attemptSignal),
            `Implementer call for ${task.id} failed`,
          ),
        (discarded) => {
          shared.state = addUsageAndSave(seatRef, shared.state, 'implementer', discarded.usage);
          input.setTrackedState(shared.state);
        },
      ),
  });
  return attempt.value;
}

function absorbCorrections(input: ImplementerLoopInput, shared: ImplementerLoopState): number {
  const { wctx, task } = input;
  const absorbed = absorbBuildCorrections({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    state: shared.state,
    taskId: task.id,
    bus: wctx.bus,
    config: wctx.config,
    modelCache: wctx.modelCache,
  });
  shared.state = absorbed.state;
  input.setTrackedState(shared.state);
  return absorbed.count;
}

function implementerCall(
  input: ImplementerLoopInput,
  shared: ImplementerLoopState,
  signal: AbortSignal,
  recordOutput: (text: string) => void,
): ImplementerOptions {
  const { wctx, task, workspace } = input;
  const { projectDir, sessionId, config, context } = wctx;
  return {
    task,
    ...(wctx.steering !== undefined && { steering: wctx.steering }),
    projectDir: workspace.projectDir,
    config,
    context,
    languageContext: buildProjectLanguageContext(
      wctx.workspaceDir,
      shared.state.discoveredValidation?.language,
    ),
    plan: shared.state.plan,
    onOutput: (text, opts) => {
      recordOutput(text);
      input.textHandler(text, opts);
      input.streamingFeed.onText(text);
    },
    sessionId,
    signal,
    sandboxEnv: workspace.sandboxEnv,
    fileIgnoreProjectDir: projectDir,
    changeDetection: workspace.changeDetection,
    phase: shared.state.phase,
    lineageAttempt: lineageAttemptsOf(shared.state, task) + 1,
    approveWrite: (file) => approveWrite(input, shared, file),
  };
}

function creationOwnership(
  input: ImplementerLoopInput,
  shared: ImplementerLoopState,
): Pick<ImplementerOptions, 'createdByThisTask'> {
  const { wctx, task, workspace } = input;
  const createdByThisTask = recordedApiCreatedPaths(
    { projectDir: wctx.projectDir, sessionId: wctx.sessionId },
    task,
    workspace.projectDir,
  );
  return createdByThisTask.length > 0 || shared.state.workspace?.kind === 'checkout'
    ? { createdByThisTask }
    : {};
}

async function produce(
  input: ImplementerLoopInput,
  shared: ImplementerLoopState,
  prepared: {
    call: ImplementerOptions;
    partial: string | undefined;
    seatRef: WorkflowPersistenceContext;
  },
  attemptSignal: AbortSignal,
): Promise<ImplementerResult> {
  const { wctx, task, workspace, taskStartSnapshot } = input;
  const { projectDir, sessionId } = wctx;
  const { call, partial, seatRef } = prepared;
  await settleMidCallDeliveries({ projectDir, sessionId });
  absorbCorrections(input, shared);
  const correction = buildCorrectionInput(shared.state, task, wctx);
  const changed = await changedDeclaredFiles(workspace.projectDir, task, taskStartSnapshot);
  const continuation = briefContinuation({
    changed,
    partial,
    steer: correction.continuation?.steer,
  });
  const guidance = unfinishedGuidance(shared.state, task);
  const resumed = guidance === undefined ? continuation : { ...continuation, guidance };
  // A fix task may already have its code on disk when none of its findings needs a change,
  // and a cut attempt may find its kept work complete: either call may change nothing.
  const allowNoChange = task.fix !== undefined || continuation?.kept !== undefined;
  const firstCall: ImplementerOptions = {
    ...call,
    ...correction,
    signal: attemptSignal,
    ...creationOwnership(input, shared),
    ...(resumed !== undefined && { continuation: resumed }),
    ...(allowNoChange && { allowNoChange }),
  };
  return runWithCorrectionPasses({
    ref: { projectDir, sessionId },
    first: () => wctx.implementer.implement(firstCall),
    pass: async () => {
      const correction = buildCorrectionInput(shared.state, task, wctx);
      return wctx.implementer.implement({
        ...call,
        ...correction,
        signal: attemptSignal,
        ...creationOwnership(input, shared),
        continuation: {
          ...correction.continuation,
          ...changedDeclaredFilesNote(
            await changedDeclaredFiles(workspace.projectDir, task, taskStartSnapshot),
          ),
        },
        allowNoChange: true,
      });
    },
    absorb: () => absorbCorrections(input, shared),
    signal: attemptSignal,
    onDiscardedUsage: (usage) => {
      shared.state = addUsageAndSave(seatRef, shared.state, 'implementer', usage);
      input.setTrackedState(shared.state);
    },
    application: {
      wctx,
      state: () => shared.state,
      task,
      workspacePath: workspace.projectDir,
    },
  });
}
