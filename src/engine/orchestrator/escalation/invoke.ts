import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { withContinuationLoop } from '../continuation/loop.js';
import { recordedApiCreatedPaths } from '../evidence/target-writes.js';
import { settleThrownCall } from '../isolation/retention.js';
import type { AttemptWorkspace } from '../isolation/types.js';
import { briefContinuation, changedDeclaredFiles } from '../kept-work.js';
import { recordSteerCorrection } from '../queue/build-corrections.js';
import { withAttemptRestoreScope } from '../task/restore-scope.js';
import type { RetryInvokeResult, RetryStepOpts } from './types.js';

/**
 * The call of one retry attempt in its workspace. A stop of this call parks the attempt; the steer
 * continues it on the edits it already made. A call that throws settles its workspace first.
 */
export async function invokeRetryAttempt(
  opts: RetryStepOpts,
  workspace: AttemptWorkspace,
): Promise<{ state: WorkflowState; value: RetryInvokeResult }> {
  const { ctx, task, lastError, usageCategory, invokeRetry } = opts;
  let state = opts.state;
  try {
    return await withContinuationLoop<RetryInvokeResult>({
      ctx: {
        projectDir: workspace.projectDir,
        sessionId: ctx.sessionId,
        persistRef: { projectDir: ctx.projectDir, sessionId: ctx.sessionId },
        callbacks: ctx.callbacks,
        bus: ctx.bus,
        signal: ctx.signal,
        sinks: ctx.sinks,
      },
      state,
      step: { kind: 'brief', taskId: task.id, attempt: state.attempt },
      onStateChange: (next) => {
        state = next;
      },
      body: async ({ signal, partial, steerInput, recordOutput }) => {
        if (steerInput !== undefined) {
          state = recordSteerCorrection({ ...ctx, state, taskId: task.id, message: steerInput });
        }
        const changed = await changedDeclaredFiles(
          workspace.projectDir,
          task,
          ctx.taskStartSnapshot,
        );
        const continuation = briefContinuation({ changed, partial });
        return withAttemptRestoreScope({
          ref: ctx,
          dir: workspace.projectDir,
          taskStartSnapshot: ctx.taskStartSnapshot,
          attemptSnapshot: workspace.snapshot,
          run: () =>
            invokeRetry({
              task,
              lastError,
              attempts: state.attempt,
              projectDir: workspace.projectDir,
              config: ctx.config,
              implementer: ctx.implementer,
              ...(ctx.implementerProfile !== undefined && {
                implementerProfile: ctx.implementerProfile,
              }),
              signal,
              sandboxEnv: workspace.sandboxEnv,
              fileIgnoreProjectDir: ctx.projectDir,
              changeDetection: workspace.changeDetection,
              createdByThisTask: recordedApiCreatedPaths(ctx, task, workspace.projectDir),
              deliversAnswer: opts.deliversAnswer,
              ...(continuation !== undefined && { continuation }),
              recordOutput,
              seat: { ref: ctx, state, usageCategory },
            }),
        });
      },
    });
  } catch (err) {
    await settleThrownCall(workspace, ctx.signal, err);
    throw err;
  }
}
