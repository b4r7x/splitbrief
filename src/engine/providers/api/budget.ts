import type { Task } from '../../../core/schemas/task.js';
import { estimateTokens } from '../../../core/tokens/estimate.js';
import type {
  ApiBudgetBuildTarget,
  MeasureApiBudgetOptions,
  ApiBudgetMeasurement,
} from './runtime-context.js';

/** Per-message envelope the wire format adds around each content string. */
const MESSAGE_OVERHEAD_TOKENS = 8;
/** Request envelope counted once, beside the per-message overhead. */
const REQUEST_OVERHEAD_TOKENS = 16;
/** How far the character-ratio estimate is allowed to be wrong, as a share. */
const ESTIMATION_MARGIN_RATIO = 0.15;
/** The floor every role reserves, and what PLAN and REVIEW reserve. */
export const BASE_OUTPUT_RESERVE_TOKENS = 2_048;
/** Allowance for one declared `create` target, whose text has no baseline. */
const CREATE_TARGET_RESERVE_TOKENS = 2_048;
/** How much a rewritten file is allowed to grow over its baseline. */
const BUNDLE_GROWTH_RATIO = 1.25;

/**
 * A conservative output allowance for a bundle covering every declared target:
 * the escaped JSON of the `modify` baselines plus room to grow, and a flat
 * allowance per `create`. Every declared target counts even if the eventual
 * bundle omits it. An allowance, not a guarantee the generated text fits.
 */
export function estimateBundleOutputReserve(
  targets: readonly ApiBudgetBuildTarget[],
  modelId?: string,
): number {
  const modifications = targets.filter((target) => target.action === 'modify');
  const creations = targets.length - modifications.length;
  const baseline = estimateTokens(JSON.stringify({ version: 1, files: modifications }), modelId);
  const reserve =
    Math.ceil(baseline * BUNDLE_GROWTH_RATIO) + creations * CREATE_TARGET_RESERVE_TOKENS;
  return Math.max(BASE_OUTPUT_RESERVE_TOKENS, reserve);
}

/**
 * Plan one call against the seat's resolved context. `inputEstimate` is a
 * character-ratio approximation of the final messages, never a tokenizer
 * measurement, so `estimationMargin` rides beside it. A reserve that does not
 * fit refuses with its exact figures rather than shrinking to be admitted.
 */
export function measureApiBudget(options: MeasureApiBudgetOptions): ApiBudgetMeasurement {
  const { context, messages, role } = options;
  const modelId = context.selectionId;

  const content = messages.reduce(
    (total, message) => total + estimateTokens(message.content, modelId),
    0,
  );
  const inputEstimate =
    content + MESSAGE_OVERHEAD_TOKENS * messages.length + REQUEST_OVERHEAD_TOKENS;
  const estimationMargin = Math.ceil(inputEstimate * ESTIMATION_MARGIN_RATIO);

  const applicationContextTokens = context.applicationContextTokens;
  const outputReserve =
    role === 'build'
      ? estimateBundleOutputReserve(options.buildTargets ?? [], modelId)
      : BASE_OUTPUT_RESERVE_TOKENS;

  const minimumRequiredTokens = inputEstimate + estimationMargin + outputReserve;
  const outputCap = context.maximumOutputTokens;
  const refusal = {
    inputEstimate,
    estimationMargin,
    requiredOutputTokens: outputReserve,
    applicationContextTokens,
    ...(outputCap !== undefined && { outputCap }),
    minimumRequiredTokens,
  };
  if (outputCap !== undefined && outputReserve > outputCap) {
    return { kind: 'insufficient', reason: 'output', ...refusal };
  }
  if (minimumRequiredTokens > applicationContextTokens) {
    return { kind: 'insufficient', reason: 'input', ...refusal };
  }
  const headroom = applicationContextTokens - inputEstimate - estimationMargin;
  return {
    kind: 'fits',
    inputEstimate,
    estimationMargin,
    outputReserve,
    ...(outputCap !== undefined && { maxTokens: Math.min(outputCap, headroom), outputCap }),
    applicationContextTokens,
  };
}

/**
 * Every target the brief declares, each `modify` carrying the baseline captured
 * at task start so the output reserve covers rewriting it. A declared path with
 * no captured baseline counts as a `create`.
 */
export function apiBuildTargets(task: Task): readonly ApiBudgetBuildTarget[] {
  return task.suggestedFiles.map((path) => {
    const baseline =
      path === task.suggestedFiles[0] ? task.currentCode : task.currentCodeByFile?.[path];
    return baseline !== undefined
      ? { path, action: 'modify' as const, content: baseline }
      : { path, action: 'create' as const };
  });
}
