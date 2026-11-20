import { estimateTokens } from '../../../core/tokens/estimate.js';
import { buildImplementerSystemPreamble } from '../../spec/prompts/system.js';
import { formatTaskPrompt } from '../../spec/prompts/task.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import type { TaskContextFit } from '../../../core/schemas/enums.js';
import type {
  BuildContextOverflow,
  TaskPromptEstimateOptions,
  ContextFitOptions,
} from './types.js';

const DEFAULT_SAFETY_MARGIN = 0.15;
const DEFAULT_TIGHT_THRESHOLD = 0.8;

export function estimateFormattedTaskPromptTokens(
  opts: TaskPromptEstimateOptions & { modelId?: string | undefined },
): number {
  const languageContext = opts.languageContext ?? buildLanguageContext(undefined);
  const writesFiles = opts.writesFiles ?? 'extracted-code';
  const prompt = formatTaskPrompt({
    task: opts.task,
    context: opts.context,
    contextLength: opts.contextLength,
    languageContext,
    writesFiles,
    outputContract: opts.outputContract,
    plan: opts.plan,
  });
  // Routing runs before the isolation directory exists; the project path stands in for its length.
  return (
    estimateTokens(
      buildImplementerSystemPreamble(
        languageContext,
        writesFiles,
        opts.context.dir,
        opts.outputContract,
      ),
      opts.modelId,
    ) + estimateTokens(prompt, opts.modelId)
  );
}

export function classifyContextFit(
  estimatedTokens: number,
  contextLength: number,
  opts: ContextFitOptions = {},
): TaskContextFit {
  const tightThreshold = opts.tightThreshold ?? DEFAULT_TIGHT_THRESHOLD;
  const estimatedWithSafety = contextFitRequirement(estimatedTokens, opts);

  if (estimatedWithSafety > contextLength) return 'overflow';
  if (estimatedWithSafety > Math.floor(contextLength * tightThreshold)) return 'tight';
  return 'fits';
}

export function contextFitRequirement(estimatedTokens: number, opts: ContextFitOptions): number {
  return Math.ceil(estimatedTokens * (1 + (opts.safetyMargin ?? DEFAULT_SAFETY_MARGIN)));
}

export function formatBuildContextOverflow(overflow: BuildContextOverflow): string {
  const required = overflow.requiredTokens.toLocaleString('en-US');
  const available = overflow.availableTokens.toLocaleString('en-US');
  return `The brief needs about ${required} tokens. The BUILD seat can take at most ${available}.`;
}
