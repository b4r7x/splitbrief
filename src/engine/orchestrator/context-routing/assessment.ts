import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { missingRunnerCredential } from '../../../core/config/accessors/runner-credentials.js';
import type { Task } from '../../../core/schemas/task.js';
import { estimateTokens } from '../../../core/tokens/estimate.js';
import { formatTaskPrompt } from '../../spec/prompt-formatter.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import { buildSystemPreamble } from '../../spec/prompts/system.js';
import { isProviderId } from '../../../core/schemas/enums.js';
import { getEffectiveModelId } from '../../providers/model/resolution.js';
import type { ProfileFit, RouteTaskOptions, TaskContextFit, CurrentCodeContextMode } from './types.js';
import { resolveProfileContextLength, profileProviderId } from './context-length.js';
import { estimateFormattedTaskPromptTokens, classifyContextFit } from './estimation.js';
import { requiredWriteModeForTask } from './helpers.js';

const DEFAULT_CONSERVATIVE_CONTEXT_LENGTH = 8192;
const TRUNCATION_MARKER = '// ... truncated to fit context window ...';
const FUNCTION_CONTEXT_HEADING = '### Current Code (relevant section)';
const WHOLE_FILE_CONTEXT_HEADING = '### Current Code';

function currentCodeContextMode(task: Task, prompt: string): CurrentCodeContextMode {
  if (task.action !== 'modify' || !task.currentCode) return 'none';
  if (prompt.includes(FUNCTION_CONTEXT_HEADING)) return 'function-level';
  if (prompt.includes(TRUNCATION_MARKER)) return 'truncated';
  if (!prompt.includes(WHOLE_FILE_CONTEXT_HEADING)) return 'none';
  return prompt.includes(task.currentCode) ? 'whole-file' : 'truncated';
}

function determineFit(
  currentCodeTruncated: boolean,
  mode: CurrentCodeContextMode,
  formattedFit: TaskContextFit,
  untruncatedFit: TaskContextFit,
): TaskContextFit {
  if (currentCodeTruncated && untruncatedFit === 'overflow') return 'overflow';
  if (formattedFit === 'fits' && mode !== 'whole-file' && untruncatedFit !== 'fits') return 'tight';
  return formattedFit;
}

export function assessProfile(opts: RouteTaskOptions, profile: ResolvedImplementerProfile): ProfileFit {
  const conservativeContextLength = opts.conservativeContextLength ?? DEFAULT_CONSERVATIVE_CONTEXT_LENGTH;
  const { contextLength, usedConservativeContextLength } = resolveProfileContextLength(
    profile,
    conservativeContextLength,
    opts.contextCache,
  );
  const providerId = profileProviderId(profile);
  const modelId = isProviderId(providerId) ? getEffectiveModelId(providerId, profile.config.model) : undefined;
  const languageContext = opts.languageContext ?? buildLanguageContext(undefined);
  const untruncatedEstimatedTokens = estimateFormattedTaskPromptTokens({ task: opts.task, context: opts.context, languageContext, modelId });
  const prompt = formatTaskPrompt(opts.task, opts.context, contextLength, languageContext);
  const estimatedTokens = estimateTokens(buildSystemPreamble(languageContext), modelId) + estimateTokens(prompt, modelId);
  const mode = currentCodeContextMode(opts.task, prompt);
  const currentCodeTruncated = mode === 'truncated';
  const formattedFit = classifyContextFit(estimatedTokens, contextLength, opts);
  const untruncatedFit = classifyContextFit(untruncatedEstimatedTokens, contextLength, opts);
  const fit = determineFit(currentCodeTruncated, mode, formattedFit, untruncatedFit);
  const requiredWriteMode = requiredWriteModeForTask(opts.task);
  const credentialFailure = credentialFailureReason(profile);
  const capabilityFailure = requiredWriteMode === 'direct' && profile.capabilities.writesFiles !== 'direct'
    ? `Task scope requires direct file writes; profile writes via ${profile.capabilities.writesFiles}`
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
  const credentialTarget = missing.envVar ? `profile apiKey or ${missing.envVar}` : 'profile apiKey';
  return `${missing.providerDisplayName} credentials are missing; set ${credentialTarget}`;
}
