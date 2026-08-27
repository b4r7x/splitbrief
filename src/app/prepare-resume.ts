import { configForSessionTranscriptPolicy } from '../core/sessions/io.js';
import { acquireStateAuthority, releaseStateAuthority } from '../core/state/authority.js';
import { loadStateForResume } from '../core/state/persistence.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import type { SessionRef } from '../core/types/session-ref.js';
import { prepareExecution } from '../engine/runners/prepare-execution.js';
import type { PreparationPolicy } from '../engine/runners/prepare-execution.js';
import type { PreparationOutcome } from '../engine/runners/prepared-execution.js';
import { closeApprovalPrompt, openApprovalPrompt } from '../stores/approval-prompt/prompt.js';
import type { SessionSelectDeps } from '../stores/navigation/session-select.js';
import { configStore } from '../stores/project/config.js';
import { error } from '../utils/error.js';

type InteractivePreparationPolicy = Pick<
  PreparationPolicy,
  'interaction' | 'allowHooks' | 'unverifiedAuth' | 'onTieredApproval'
>;

export const appPreparationError = {
  configNotLoaded: () => error('app-config-not-loaded', 'Project configuration is not loaded.'),
} as const;

export const interactivePreparationPolicy = {
  interaction: 'interactive',
  allowHooks: false,
  unverifiedAuth: 'disclosed',
  onTieredApproval: openApprovalPrompt,
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
    effectiveConfig: configForSessionTranscriptPolicy(config, input.ref),
    resumeState: input.state,
    signal,
    policy: {
      ...interactivePreparationPolicy,
      purpose: 'resume',
      allowRepoRunners: false,
    },
  });
}

export const sessionSelectDeps: SessionSelectDeps = {
  loadStateForResume,
  acquireStateAuthority,
  releaseStateAuthority,
  prepareResume: prepareSessionResume,
  cancelPendingApproval: closeApprovalPrompt,
};
