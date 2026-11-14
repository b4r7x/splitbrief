import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { WorkflowContext } from '../types.js';
import type { RoutingDecision } from './types.js';
import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { nowIso } from '../../../utils/format/time.js';
import { raisePendingRecovery } from '../state-ops/halts.js';
import { publishError } from '../publish/notice.js';
import { buildRouteTaskOptions } from './route-input.js';
import { routeTaskToImplementerProfile } from './route.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { buildContextOverflowRecoveryIssue } from '../recovery/builders/context-overflow.js';
import {
  selectedProfileFromDecision,
  retryProfileForTask,
  routingBlockMessage,
} from './profile.js';

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
  resolvedProfiles: ResolvedImplementerProfile[];
  getRunnerModelName: (config: ResolvedImplementerProfile['config']) => string | undefined;
}): Promise<RoutingSelectionResult> {
  const { wctx, task, setTrackedState, resolvedProfiles } = opts;
  const { projectDir } = wctx;
  let state = opts.state;

  const pinnedProfile = retryProfileForTask(state, task);
  const routingProfiles =
    pinnedProfile === undefined
      ? resolvedProfiles
      : resolvedProfiles.filter((profile) => profile.name === pinnedProfile);
  if (routingProfiles.length === 0) {
    const message = `Recovery selected implementer profile "${pinnedProfile}" is not configured.`;
    publishError({ bus: wctx.bus, phase: state.phase, message: message });
    const issue = buildContextOverflowRecoveryIssue({
      task,
      phase: state.phase,
      selectedImplementerProfile: pinnedProfile,
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
      plan: state.plan,
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
      selectedImplementerProfile: pinnedProfile,
      createdAt: nowIso(),
    });
    state = raisePendingRecovery(wctx, state, issue, setTrackedState);
    return { ok: false, state };
  }

  return { ok: true, state, selectedProfile, selectedModel, routingDecision };
}
