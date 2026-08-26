import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import { RecoveryActionSchema } from '../../../core/schemas/enums.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { StateAuthorityReceipt } from '../../../core/state/types.js';
import type { ActiveSessionReceipt } from '../../../core/sessions/active-pointer.js';
import type { EventBus } from '../../../engine/events/types.js';
import { applyRecoveryAction } from '../../../engine/orchestrator/recovery/actions.js';
import {
  finalizeRecoveryResult,
  loadPendingRecoveryState,
} from '../../../engine/orchestrator/recovery/driver.js';
import { publishRecoveryPrompted } from '../../../engine/orchestrator/events.js';
import { WORKFLOW_REWIND_ABORT_REASON } from '../../../engine/orchestrator/run/workflow.js';
import { matches } from '../../../utils/error.js';
import type { createGate } from '../gates.js';
import { rpcError } from '../errors.js';
import type { createResponseWriter } from '../writer.js';

type RecoveryGate = ReturnType<typeof createGate<string>>;
type ResponseWriter = ReturnType<typeof createResponseWriter>;

export function isWorkflowRewindAbortError(err: unknown): boolean {
  return matches('operation-aborted')(err) && err.message === WORKFLOW_REWIND_ABORT_REASON;
}

export type RpcRecoveryResolution = {
  shouldRun: boolean;
  state: WorkflowState;
  retryProfileOverride?: string | undefined;
  retryProfileOverrideTaskId?: TaskId | undefined;
};

export type RpcRecoveryHandlersDeps = {
  projectDir: string;
  resolveSessionId: () => string | undefined;
  setActiveSessionId: (id: string) => void;
  readCurrentState: () => WorkflowState | null;
  getAuthority?: (() => StateAuthorityReceipt | null) | undefined;
  executionConfig: () => Config;
  active: ActiveSessionReceipt;
  bus: EventBus;
  recoveryGate: RecoveryGate;
  writer: ResponseWriter;
  isRpcClosed: () => boolean;
  transportAborted: () => boolean;
};

export function createRpcRecoveryHandlers(deps: RpcRecoveryHandlersDeps) {
  const waitForRecoveryAction = (): Promise<string> => {
    if (deps.isRpcClosed()) throw rpcError.transportClosed();
    return deps.recoveryGate.wait();
  };

  const receiveRecoveryAction = (action: string): boolean => {
    if (!deps.recoveryGate.isPending()) {
      deps.writer.error(`No pending recovery prompt for action: ${action}`, {
        transcriptSensitive: true,
        summary: 'Recovery command rejected.',
      });
      return false;
    }
    const state = deps.readCurrentState();
    const issue = state?.pendingRecovery;
    if (!issue) {
      deps.writer.error('No pending recovery issue is available.');
      return false;
    }
    const parsed = RecoveryActionSchema.safeParse(action);
    if (!parsed.success) {
      deps.writer.error(`Invalid recovery action: ${action}`, {
        transcriptSensitive: true,
        summary: 'Recovery command rejected.',
      });
      return false;
    }
    if (!issue.availableActions.includes(parsed.data)) {
      deps.writer.error(`Recovery action is not available for this issue: ${action}`, {
        transcriptSensitive: true,
        summary: 'Recovery command rejected.',
      });
      return false;
    }
    if (!deps.recoveryGate.resolve(action)) {
      deps.writer.error(`Recovery action already resolved: ${action}`, {
        transcriptSensitive: true,
        summary: 'Recovery command rejected.',
      });
      return false;
    }
    return true;
  };

  const requestRecoveryAction = async (state: WorkflowState): Promise<RpcRecoveryResolution> => {
    const id = deps.resolveSessionId();
    if (!id) {
      deps.writer.error('No active session is available for recovery.');
      return { shouldRun: false, state };
    }

    deps.setActiveSessionId(id);
    const latest = deps.readCurrentState() ?? state;
    const issue = latest.pendingRecovery;
    if (!issue) return { shouldRun: true, state: latest };

    const applyAction = async (action: string): Promise<RpcRecoveryResolution | null> => {
      const parsed = RecoveryActionSchema.safeParse(action);
      if (!parsed.success) {
        deps.writer.error(`Invalid recovery action: ${action}`, {
          transcriptSensitive: true,
          summary: 'Recovery command rejected.',
        });
        return null;
      }

      const current = deps.readCurrentState() ?? latest;
      const currentIssue = current.pendingRecovery;
      if (!currentIssue) return { shouldRun: true, state: current };
      const effectiveConfig = deps.executionConfig();
      const authority = deps.getAuthority?.() ?? undefined;

      const selectedImplementerProfile = currentIssue.selectedImplementerProfile;
      const retryProfileOverrideTaskId =
        currentIssue.taskId ?? current.tasks[current.currentTaskIndex]?.id;
      const result = applyRecoveryAction({
        projectDir: deps.projectDir,
        sessionId: id,
        state: current,
        action: parsed.data,
        bus: deps.bus,
        config: effectiveConfig,
        mode: effectiveConfig.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
        ...(authority === undefined ? {} : { authority }),
      });
      if (!result.ok) {
        deps.writer.error(result.message);
        return null;
      }

      deps.writer.ack('recovery', { action: result.action, status: result.status });
      if (result.status === 'aborted') {
        finalizeRecoveryResult({
          projectDir: deps.projectDir,
          sessionId: id,
          active: deps.active,
          state: result.state,
          config: effectiveConfig,
          status: result.status,
        });
      }
      const retryProfileOverride = result.implementerProfile ?? selectedImplementerProfile;
      return {
        shouldRun: result.status !== 'paused' && result.status !== 'aborted',
        state: result.state,
        ...(retryProfileOverride !== undefined &&
          result.status === 'retry-current-task' && { retryProfileOverride }),
        ...(retryProfileOverride !== undefined &&
          result.status === 'retry-current-task' &&
          retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
      };
    };

    if (issue.status === 'applying') {
      const action = issue.selectedAction;
      if (!action) {
        deps.writer.error('Recovery is applying but no action is selected.');
        return { shouldRun: false, state: latest };
      }
      const applied = await applyAction(action);
      if (!applied) return { shouldRun: false, state: latest };
      return applied;
    }

    const pending = loadPendingRecoveryState(
      { projectDir: deps.projectDir, sessionId: id },
      latest,
    );
    if (!pending.pending) return { shouldRun: true, state: pending.state };

    publishRecoveryPrompted(deps.bus, pending.issue);
    deps.writer.status({ pending: 'recovery', issue: pending.issue });

    while (!deps.transportAborted()) {
      let action: string;
      try {
        action = await waitForRecoveryAction();
      } catch (err) {
        if (isWorkflowRewindAbortError(err)) {
          return { shouldRun: true, state: deps.readCurrentState() ?? state };
        }
        throw err;
      }
      const applied = await applyAction(action);
      if (!applied) continue;
      return applied;
    }

    return { shouldRun: false, state };
  };

  return { receiveRecoveryAction, requestRecoveryAction };
}
