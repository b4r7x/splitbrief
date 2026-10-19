import { loadOwnerWorkflowState } from '../core/state/resume-hydration.js';
import { atRestResumePolicy } from '../features/workflow/resume-policy.js';
import { hydrateRun, readRunHistory } from '../features/workflow/run-history.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import type { SessionRef } from '../core/types/session-ref.js';
import { prepareExecution } from '../engine/runners/prepare-execution/prepare-execution.js';
import { activeApply } from '../engine/orchestrator/session-lifecycle/shutdown.js';
import type { PreparationPolicy } from '../engine/runners/prepare-execution/types.js';
import type { PreparationOutcome } from '../engine/runners/prepared-execution.js';
import { closeApprovalPrompt, openApprovalPrompt } from '../stores/approval-prompt/prompt.js';
import type { SessionSelectDeps } from '../stores/navigation/session-select.js';
import { configStore } from '../stores/project/config.js';
import { modelCacheStore } from '../stores/discovery/model-cache/state.js';
import { error } from '../utils/error.js';

type InteractivePreparationPolicy = Pick<
  PreparationPolicy,
  'interaction' | 'allowHooks' | 'unverifiedAuth' | 'onTieredApproval' | 'modelCache'
>;

export const appPreparationError = {
  configNotLoaded: () => error('app-config-not-loaded', 'Project configuration is not loaded.'),
} as const;

export const interactivePreparationPolicy = {
  interaction: 'interactive',
  allowHooks: false,
  unverifiedAuth: 'disclosed',
  onTieredApproval: openApprovalPrompt,
  modelCache: modelCacheStore,
} satisfies InteractivePreparationPolicy;

export async function prepareSessionResume(
  input: Readonly<{
    ref: SessionRef;
    state: WorkflowState;
  }>,
  signal: AbortSignal,
): Promise<PreparationOutcome> {
  const config = configStore.get().config;
  if (config === null) {
    return { kind: 'failed', error: appPreparationError.configNotLoaded() };
  }

  return prepareExecution({
    existingSession: input.ref,
    feature: input.state.feature,
    effectiveConfig: config,
    resumeState: input.state,
    signal,
    policy: atRestResumePolicy(input.ref),
  });
}

export const sessionSelectDeps: SessionSelectDeps = {
  loadResumeState: loadOwnerWorkflowState,
  prepareResume: prepareSessionResume,
  hydrateRun,
  readRunHistory,
  cancelPendingApproval: closeApprovalPrompt,
  applying: () => activeApply() !== undefined,
};
