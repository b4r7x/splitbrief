import { taskFiles } from '../../../core/schemas/task.js';
import { selectBuildOutputContract } from '../../implementers/file-bundle.js';
import { apiBuildTargets, estimateBundleOutputReserve } from '../../providers/api-budget.js';
import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { missingRunnerCredential } from '../../../core/config/accessors/runner-credentials.js';
import { estimateTokens } from '../../../core/tokens/estimate.js';
import { DEFAULT_UNKNOWN_CONTEXT_LENGTH } from '../../../core/tokens/context-length.js';
import { formatImplementerSystemPreamble, formatTaskPrompt } from '../../spec/prompt-formatter.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import { isProviderId } from '../../../core/schemas/enums.js';
import { getEffectiveModelId } from '../../providers/model/resolution.js';
import type { ProfileFit, RouteTaskOptions } from './types.js';
import type { CurrentCodeContextMode, TaskContextFit } from '../../../core/schemas/enums.js';
import { resolveProfileContextLength, profileProviderId } from './context-length.js';
import { estimateFormattedTaskPromptTokens, classifyContextFit } from './estimation.js';
import { currentCodeContextMode } from './headings.js';
import { requiredWriteModeForTask } from './decision.js';

function determineFit(opts: {
  currentCodeTruncated: boolean;
  mode: CurrentCodeContextMode;
  formattedFit: TaskContextFit;
  untruncatedFit: TaskContextFit;
}): TaskContextFit {
  const { currentCodeTruncated, mode, formattedFit, untruncatedFit } = opts;
  if (currentCodeTruncated && untruncatedFit === 'overflow') return 'overflow';
  if (formattedFit === 'fits' && mode !== 'whole-file' && untruncatedFit !== 'fits') return 'tight';
  return formattedFit;
}

export function assessProfile(
  opts: RouteTaskOptions,
  profile: ResolvedImplementerProfile,
): ProfileFit {
  const conservativeContextLength =
    opts.conservativeContextLength ?? DEFAULT_UNKNOWN_CONTEXT_LENGTH;
  const { contextLength, usedConservativeContextLength } = resolveProfileContextLength(
    profile,
    conservativeContextLength,
    opts.modelCache,
    opts.detectedContextLength,
  );
  const providerId = profileProviderId(profile);
  const modelId = isProviderId(providerId)
    ? getEffectiveModelId(providerId, profile.config.model)
    : undefined;
  const languageContext = opts.languageContext ?? buildLanguageContext(undefined);
  const writesFiles = profile.capabilities.writesFiles;
  const outputContract = selectBuildOutputContract({
    extractsCode: writesFiles === 'extracted-code',
    backendKind: profile.config.kind,
  });
  const untruncatedEstimatedTokens = estimateFormattedTaskPromptTokens({
    task: opts.task,
    context: opts.context,
    languageContext,
    modelId,
    writesFiles,
    outputContract,
  });
  const prompt = formatTaskPrompt({
    task: opts.task,
    context: opts.context,
    contextLength,
    languageContext,
    writesFiles,
    outputContract,
  });
  // Routing runs before the isolation directory exists; the project path stands in for its length.
  const estimatedTokens =
    estimateTokens(
      formatImplementerSystemPreamble(
        languageContext,
        writesFiles,
        opts.context.dir,
        outputContract,
      ),
      modelId,
    ) + estimateTokens(prompt, modelId);
  const mode =
    outputContract === 'file-bundle-v1'
      ? opts.task.currentCode ||
        taskFiles(opts.task).some((path) => opts.task.currentCodeByFile?.[path] !== undefined)
        ? 'whole-file'
        : 'none'
      : currentCodeContextMode(opts.task, prompt);
  const currentCodeTruncated = mode === 'truncated';
  const outputReserve =
    outputContract === 'file-bundle-v1'
      ? estimateBundleOutputReserve(apiBuildTargets(opts.task), modelId)
      : 0;
  const inputBudget = contextLength - outputReserve;
  const formattedFit = classifyContextFit(estimatedTokens, inputBudget, opts);
  const untruncatedFit = classifyContextFit(untruncatedEstimatedTokens, inputBudget, opts);
  const fit = determineFit({ currentCodeTruncated, mode, formattedFit, untruncatedFit });
  const requiredWriteMode = requiredWriteModeForTask(opts.task);
  const credentialFailure = credentialFailureReason(profile);
  const capabilityFailure =
    requiredWriteMode === 'direct' && profile.capabilities.writesFiles !== 'direct'
      ? `Task scope requires direct file writes; profile writes via ${profile.capabilities.writesFiles}`
      : outputContract === 'legacy-code-v1' && taskFiles(opts.task).length > 1
        ? 'Task requires a multi-file bundle; profile only extracts a single file'
        : undefined;

  return {
    profile,
    estimatedTokens,
    untruncatedEstimatedTokens,
    contextLength,
    currentCodeTruncated,
    currentCodeContextMode: mode,
    usedConservativeContextLength,
    requiredWriteMode,
    credentialFailure,
    capabilityFailure,
    fit,
  };
}

function credentialFailureReason(profile: ResolvedImplementerProfile): string | undefined {
  const missing = missingRunnerCredential(profile.config);
  if (!missing) return undefined;
  const credentialTarget = missing.envVar
    ? `profile apiKey or ${missing.envVar}`
    : 'profile apiKey';
  return `${missing.providerDisplayName} credentials are missing; set ${credentialTarget}`;
}
