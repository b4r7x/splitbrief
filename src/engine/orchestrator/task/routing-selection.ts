import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext } from '../types.js';
import type { RoutingDecision } from '../context-routing/types.js';
import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { nowIso } from '../../../utils/format-time.js';
import { raisePendingRecovery } from '../state-ops.js';
import { publishError } from '../events.js';
import { buildRouteTaskOptions } from '../context-routing/route-input.js';
import { routeTaskToImplementerProfile } from '../context-routing/route.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { buildContextOverflowRecoveryIssue } from '../recovery/builders/task.js';
import {
  selectedProfileFromDecision,
  retryProfileOverrideForTask,
  routingBlockMessage,
} from './routing.js';
import { stopWithReview } from './stop-with-review.js';

export type RoutingSelectionResult =
  | {
      ok: true;
      state: WorkflowState;
      selectedProfile: ResolvedImplementerProfile;
      selectedModel: string | undefined;
      routingDecision: RoutingDecision;
    }
  | { ok: false; state: WorkflowState };

export async function selectRoutingProfile(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  task: Task;
  taskIndex: number;
  resolvedProfiles: ResolvedImplementerProfile[];
  taskBreakdowns: TaskTokenUsage[];
  getRunnerModelName: (config: ResolvedImplementerProfile['config']) => string | undefined;
}): Promise<RoutingSelectionResult> {
  const { wctx, task, taskIndex, taskBreakdowns, setTrackedState, resolvedProfiles } = opts;
  const { projectDir } = wctx;
  let state = opts.state;

  const retryProfileOverride = retryProfileOverrideForTask(wctx, task);
  const routingProfiles =
    retryProfileOverride === undefined
      ? resolvedProfiles
      : resolvedProfiles.filter((profile) => profile.name === retryProfileOverride);
  if (routingProfiles.length === 0) {
    const message = `Recovery selected implementer profile "${retryProfileOverride}" is not configured.`;
    publishError({ bus: wctx.bus, phase: state.phase, message: message });
    const issue = buildContextOverflowRecoveryIssue({
      task,
      phase: state.phase,
      selectedImplementerProfile: retryProfileOverride,
      canRouteBigger: false,
      routingReason: message,
      createdAt: nowIso(),
    });
    state = raisePendingRecovery(wctx, state, issue, setTrackedState);
    return { ok: false, state };
  }

  const routingDecision = routeTaskToImplementerProfile(
    buildRouteTaskOptions({
      task,
      context: wctx.context,
      profiles: routingProfiles,
      ...(wctx.modelCache !== undefined && { modelCache: wctx.modelCache }),
      languageContext: buildProjectLanguageContext(
        projectDir,
        state.discoveredValidation?.language,
      ),
      ...(wctx.detectedContextLength !== undefined && {
        detectedContextLength: wctx.detectedContextLength,
      }),
    }),
  );
  const selectedProfile = selectedProfileFromDecision(resolvedProfiles, routingDecision);
  const selectedModel = selectedProfile
    ? opts.getRunnerModelName(selectedProfile.config)
    : undefined;
  if (!selectedProfile) {
    const message = routingBlockMessage(routingDecision);
    publishError({ bus: wctx.bus, phase: state.phase, message: message });
    const issue = buildContextOverflowRecoveryIssue({
      task,
      phase: state.phase,
      routingDecision,
      createdAt: nowIso(),
    });
    state = raisePendingRecovery(wctx, state, issue, setTrackedState);
    state = await stopWithReview({
      wctx,
      state,
      setTrackedState,
      task,
      taskIndex,
      filesTouched: issue.files,
      taskBreakdowns,
      routingDecision,
    });
    return { ok: false, state };
  }

  return { ok: true, state, selectedProfile, selectedModel, routingDecision };
}
