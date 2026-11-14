import type { AttachedInput } from '../core/schemas/attachment.js';
import type { prepareExecution } from '../engine/runners/prepare-execution/prepare.js';
import type { PreparationOutcome } from '../engine/runners/prepare-execution/prepared.js';
import type { PreparationPolicy } from '../engine/runners/prepare-execution/types.js';
import { fitCheckingRow } from '../features/workflow/input-footer-byline.js';
import type { SlowProbeText } from '../hooks/use-slow-probe-text.js';
import { modelCacheStore } from '../stores/discovery/model-cache/state.js';
import { openApprovalPrompt } from '../stores/prompts/approval.js';
import { configStore } from '../stores/project/config.js';
import { appPreparationError } from './prepare-resume.js';

/** What a new workflow is asked to do. It runs in the loaded project, on its configuration. */
export type StartRequest = Readonly<{
  feature: string;
  plannerContext?: string | undefined;
  attachedInputs?: readonly AttachedInput[] | undefined;
  allowRepoRunners: boolean;
}>;

type InteractivePreparationPolicy = Pick<
  PreparationPolicy,
  | 'interaction'
  | 'allowHooks'
  | 'unverifiedAuth'
  | 'onTieredApproval'
  | 'modelCache'
  | 'getDetectedContextLength'
>;

const interactivePreparationPolicy = {
  interaction: 'interactive',
  allowHooks: false,
  unverifiedAuth: 'disclosed',
  onTieredApproval: openApprovalPrompt,
  modelCache: modelCacheStore,
  getDetectedContextLength: configStore.getDetectedContextLength,
} satisfies InteractivePreparationPolicy;

/**
 * The tool check of a new workflow, on the configuration the store holds when the attempt runs. The
 * fields of the request go into the check as the page gives them.
 */
export async function prepareStart(
  prepare: typeof prepareExecution,
  request: StartRequest,
  signal: AbortSignal,
): Promise<PreparationOutcome> {
  const { config, configWarnings, projectDir } = configStore.get();
  if (config === null) {
    return { kind: 'failed', error: appPreparationError.configNotLoaded() };
  }
  const { allowRepoRunners, ...ask } = request;
  return prepare({
    ...ask,
    projectDir,
    effectiveConfig: config,
    configWarnings,
    signal,
    policy: { ...interactivePreparationPolicy, purpose: 'new-workflow', allowRepoRunners },
  });
}

/** The status row of a check the user waits on: the spinner frame, then the row fitted beside it. */
export function checkingStatusText(
  input: Readonly<{
    frame: string;
    stage: string | null;
    slowProbe: SlowProbeText | null;
    cancellable: boolean;
    width: number;
  }>,
): string | undefined {
  const { stage, ...row } = input;
  if (stage === null) return undefined;
  return `${row.frame} ${fitCheckingRow({ ...row, stage })}`;
}
