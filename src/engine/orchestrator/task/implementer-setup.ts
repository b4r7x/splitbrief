import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import {
  getRunnerCatalogDisplayName,
  getRunnerDisplayName,
  getRunnerModelName,
} from '../../../core/config/accessors/runner-config.js';
import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { nowIso } from '../../../utils/format/time.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import type { WorkflowContext } from '../types.js';
import { raisePendingRecovery } from '../state-ops/halts.js';
import { configForProfile, createTaskImplementer } from '../context-routing/profile.js';
import { selectRoutingProfile } from '../context-routing/select.js';
import { publishError } from '../publish/notice.js';
import { buildImplementerUnavailableRecoveryIssue } from '../recovery/builders/brief-blocked.js';

/**
 * The implementer of one brief: the routed profile, its implementer once it answers that it is
 * available, and the brief's state and context that name them. An unavailable implementer raises
 * the halt, and the brief does not start.
 */
export async function setupTaskImplementer(input: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  task: Task;
  profiles: ResolvedImplementerProfile[];
}): Promise<
  | { status: 'stopped'; state: WorkflowState }
  | { status: 'ready'; state: WorkflowState; wctx: WorkflowContext }
> {
  const { wctx, setTrackedState, task } = input;
  const routing = await selectRoutingProfile({
    wctx,
    state: input.state,
    setTrackedState,
    task,
    resolvedProfiles: input.profiles,
    getRunnerModelName,
  });
  let state = routing.state;
  if (!routing.ok) return { status: 'stopped', state };
  const { selectedProfile, selectedModel, routingDecision } = routing;

  const taskImplementer = await createTaskImplementer({
    wctx,
    profile: selectedProfile,
    singleImplementerMode: wctx.config.implementerProfiles === undefined,
  });
  let isImplementerAvailable = false;
  let availabilityError: string | undefined;
  try {
    isImplementerAvailable = await taskImplementer.isAvailable();
  } catch (err) {
    availabilityError = toErrorMessage(err);
  }
  // A stop during the gate is not a verdict on the implementer.
  if (wctx.signal?.aborted) return { status: 'stopped', state };
  if (!isImplementerAvailable) {
    const tool = getRunnerCatalogDisplayName(selectedProfile.config);
    const reason =
      availabilityError ??
      taskImplementer.unavailabilityReason?.() ??
      `Selected implementer profile ${selectedProfile.name} (${tool}) is unavailable. Check runner installation, API credentials, or endpoint reachability.`;
    publishError({ bus: wctx.bus, phase: state.phase, message: reason });
    state = raisePendingRecovery(
      wctx,
      state,
      buildImplementerUnavailableRecoveryIssue({
        task,
        phase: state.phase,
        selectedImplementerProfile: selectedProfile.name,
        tool,
        ...(selectedModel !== undefined && { model: selectedModel }),
        availabilityReason: reason,
        createdAt: nowIso(),
      }),
      setTrackedState,
    );
    return { status: 'stopped', state };
  }
  const { implementerModel: _previousImplementerModel, ...stateWithoutImplementerModel } = state;
  return {
    status: 'ready',
    state: {
      ...stateWithoutImplementerModel,
      implementerTool: getRunnerDisplayName(selectedProfile.config),
      ...(selectedModel !== undefined && { implementerModel: selectedModel }),
    },
    wctx: {
      ...wctx,
      config: configForProfile(wctx.config, selectedProfile),
      implementer: taskImplementer,
      implementerProfile: selectedProfile.name,
      routingDecision,
    },
  };
}
