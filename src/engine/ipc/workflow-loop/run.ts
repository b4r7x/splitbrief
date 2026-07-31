import { runWorkflow as runWorkflowDefault } from '../../orchestrator/run/workflow.js';
import type { RunWorkflowOptions } from '../../orchestrator/run/init.js';
import type { IpcWorkflowBridge } from '../workflow-bridge.js';
import { createServerArgsAttachmentDrain } from '../server-args.js';
import type { IpcServer } from '../server.js';
import type { Summary } from '../../../core/schemas/summary.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { Config } from '../../../core/schemas/config.js';
import { buildDetachedRetryState } from '../retry-state.js';
import type { EventBus } from '../../events/types.js';
import { assertPromptResponse, makeCallbacks } from './prompts.js';
import {
  buildPausedSummary,
  resolveDetachedPendingRecovery,
  type WorkflowLoopContext,
} from './recovery.js';

export type { WorkflowLoopContext };

export type RunWorkflowFn = (options: RunWorkflowOptions) => Promise<Summary>;

export async function runWorkflowLoop(
  ctx: WorkflowLoopContext,
  ipcServer: IpcServer,
  ipcBridge: IpcWorkflowBridge,
  ipcBus: EventBus,
  config: Config,
  runWorkflow: RunWorkflowFn = runWorkflowDefault,
): Promise<Summary> {
  const sessionRef = { projectDir: ctx.projectDir, sessionId: ctx.sessionId };
  let stateForRun: WorkflowState | undefined = loadState(sessionRef) ?? undefined;
  let retryProfileOverride: string | undefined;
  let retryProfileOverrideTaskId: TaskId | undefined;
  const drainPendingAttachments = createServerArgsAttachmentDrain(ctx.attachments);

  while (true) {
    if (stateForRun?.pendingRecovery) {
      const recovery = await resolveDetachedPendingRecovery(
        ctx,
        ipcServer,
        ipcBus,
        config,
        stateForRun,
      );
      if (!recovery.shouldRun) {
        return buildPausedSummary(ctx, recovery.state, config);
      }
      stateForRun = recovery.state;
      retryProfileOverride = recovery.retryProfileOverride;
      retryProfileOverrideTaskId = recovery.retryProfileOverrideTaskId;
    }

    const summary = await runWorkflow({
      feature: ctx.feature,
      plannerContext: ctx.plannerContext,
      projectDir: ctx.projectDir,
      config,
      allowHooks: ctx.allowHooks ?? false,
      allowRepoRunners: ctx.allowRepoRunners ?? false,
      sessionId: ctx.sessionId,
      eventBus: ipcBus,
      sinks: ipcBridge.sinks,
      signal: ipcBridge.signal,
      drainPendingAttachments,
      callbacks: makeCallbacks(ipcServer),
      ...(stateForRun !== undefined && { savedState: stateForRun }),
      ...(retryProfileOverride !== undefined && { retryProfileOverride }),
      ...(retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
      trustedCliGates: ctx.trustedCliGates,
    });
    retryProfileOverride = undefined;
    retryProfileOverrideTaskId = undefined;

    const saved = loadState(sessionRef);
    if (saved?.pendingRecovery) {
      stateForRun = saved;
      continue;
    }
    if (saved?.rewindPending) {
      stateForRun = saved;
      continue;
    }

    // Never fall back to the boot-time state (or undefined) at the failure prompt — that
    // re-plans from scratch and re-runs already-completed tasks. Carry the persisted state.
    stateForRun = saved ?? stateForRun;

    const completedTasks = summary.completedByLocal + summary.escalatedToPlanner + summary.skipped;
    const isIncomplete = summary.totalTasks > 0 && completedTasks < summary.totalTasks;
    if (summary.failed === 0 && !isIncomplete) {
      return summary;
    }

    const response = assertPromptResponse(
      await ipcServer.requestClientPrompt({
        kind: 'recovery_needed',
        issue: {
          id: 'workflow-failure',
          reason: 'implementation-error' as const,
          phase: stateForRun?.phase ?? 'complete',
          files: [],
          affectedTaskIds: [],
          availableActions: ['retry-same-worker' as const, 'abort-workflow' as const],
          recommendedAction: 'retry-same-worker' as const,
        },
      }),
      'recovery_needed',
    );

    if (response.action === 'abort-workflow') {
      return summary;
    }

    if (stateForRun) {
      stateForRun = buildDetachedRetryState(stateForRun);
      saveState(sessionRef, stateForRun);
    }
  }
}
