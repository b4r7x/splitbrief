import { estimateTokens } from '../../../core/tokens/estimate.js';
import { formatTaskPrompt } from '../../spec/prompt-formatter.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import { buildSystemPreamble } from '../../spec/prompts/system.js';
import type { TaskContextFit } from '../../../core/schemas/enums.js';
import type { TaskPromptEstimateOptions, ContextFitOptions } from './types.js';

const DEFAULT_SAFETY_MARGIN = 0.15;
const DEFAULT_TIGHT_THRESHOLD = 0.8;

export function estimateFormattedTaskPromptTokens(
  opts: TaskPromptEstimateOptions & { modelId?: string | undefined },
): number {
  const languageContext = opts.languageContext ?? buildLanguageContext(undefined);
  const prompt = formatTaskPrompt({
    task: opts.task,
    context: opts.context,
    contextLength: opts.contextLength,
    languageContext,
  });
  return (
    estimateTokens(buildSystemPreamble(languageContext), opts.modelId) +
    estimateTokens(prompt, opts.modelId)
  );
}

export function classifyContextFit(
  estimatedTokens: number,
  contextLength: number,
  opts: ContextFitOptions = {},
): TaskContextFit {
  const safetyMargin = opts.safetyMargin ?? DEFAULT_SAFETY_MARGIN;
  const tightThreshold = opts.tightThreshold ?? DEFAULT_TIGHT_THRESHOLD;
  const estimatedWithSafety = Math.ceil(estimatedTokens * (1 + safetyMargin));

  if (estimatedWithSafety > contextLength) return 'overflow';
  if (estimatedWithSafety > Math.floor(contextLength * tightThreshold)) return 'tight';
  return 'fits';
}
