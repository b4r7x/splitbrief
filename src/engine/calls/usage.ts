import { z } from 'zod';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { RunnerCallUsageSchema, RunnerCallUsageSemanticsSchema } from './schema.js';
import type { RunnerCallUsage, RunnerCallUsageSemantics } from './types.js';

const tokenCount = z.number().int().nonnegative();

const PromptTokensDetailsSchema = z.looseObject({
  cached_tokens: tokenCount.optional(),
});

const CompletionTokensDetailsSchema = z.looseObject({
  reasoning_tokens: tokenCount.optional(),
});

export const BackendTokenUsageSchema = z.looseObject({
  input_tokens: tokenCount.optional(),
  output_tokens: tokenCount.optional(),
  cached_input_tokens: tokenCount.optional(),
  cache_read_input_tokens: tokenCount.optional(),
  cache_write_input_tokens: tokenCount.optional(),
  cache_creation_input_tokens: tokenCount.optional(),
  prompt_tokens: tokenCount.optional(),
  completion_tokens: tokenCount.optional(),
  prompt_tokens_details: PromptTokensDetailsSchema.nullish(),
  completion_tokens_details: CompletionTokensDetailsSchema.nullish(),
  inputTokens: tokenCount.optional(),
  outputTokens: tokenCount.optional(),
  cacheReadTokens: tokenCount.optional(),
  cacheWriteTokens: tokenCount.optional(),
  cacheCreateTokens: tokenCount.optional(),
  reasoningTokens: tokenCount.optional(),
});

type BackendTokenUsage = z.infer<typeof BackendTokenUsageSchema>;

export interface RunnerCallUsageSample {
  readonly semantics: RunnerCallUsageSemantics;
  readonly usage: RunnerCallUsage;
}

export function normalizeRunnerCallUsage(raw: unknown): RunnerCallUsage | null {
  const parsed = BackendTokenUsageSchema.safeParse(raw);
  if (!parsed.success) return null;
  return normalizeParsedUsage(parsed.data);
}

export function normalizeRunnerCallUsageSample(opts: {
  readonly raw: unknown;
  readonly semantics: unknown;
}): RunnerCallUsageSample | null {
  const usage = normalizeRunnerCallUsage(opts.raw);
  if (usage === null) return null;

  const semantics = RunnerCallUsageSemanticsSchema.safeParse(opts.semantics);
  if (!semantics.success) return null;

  return {
    semantics: semantics.data,
    usage,
  };
}

export function toTokenDelta(raw: unknown): TokenDelta | null {
  const usage = normalizeRunnerCallUsage(raw);
  return usage === null ? null : toTokenDeltaFromRunnerCallUsage(usage);
}

export function toTokenDeltaFromRunnerCallUsage(usage: RunnerCallUsage): TokenDelta {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined && { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheCreateTokens !== undefined && { cacheCreateTokens: usage.cacheCreateTokens }),
  };
}

export function accumulateRunnerCallUsage(
  current: RunnerCallUsage | null,
  next: RunnerCallUsage,
  semantics: RunnerCallUsageSemantics = 'delta',
): RunnerCallUsage {
  switch (semantics) {
    case 'delta':
      return addRunnerCallUsage(current, next);
    case 'cumulative':
    case 'final':
      return copyRunnerCallUsage(next);
    default: {
      const exhaustive: never = semantics;
      return exhaustive;
    }
  }
}

export function applyRunnerCallUsageSample(
  current: RunnerCallUsage | null,
  sample: RunnerCallUsageSample,
): RunnerCallUsage {
  return accumulateRunnerCallUsage(current, sample.usage, sample.semantics);
}

export function accumulateRunnerCallUsageSamples(
  samples: Iterable<RunnerCallUsageSample>,
): RunnerCallUsage | null {
  let usage: RunnerCallUsage | null = null;
  for (const sample of samples) {
    usage = applyRunnerCallUsageSample(usage, sample);
  }
  return usage;
}

export function accumulateTokenUsage(
  current: TokenDelta | null,
  next: TokenDelta,
  semantics: RunnerCallUsageSemantics = 'delta',
): TokenDelta {
  return toTokenDeltaFromRunnerCallUsage(accumulateRunnerCallUsage(current, next, semantics));
}

function normalizeParsedUsage(raw: BackendTokenUsage): RunnerCallUsage | null {
  const cacheReadTokens =
    raw.cache_read_input_tokens ??
    raw.cached_input_tokens ??
    raw.prompt_tokens_details?.cached_tokens ??
    raw.cacheReadTokens;
  const cacheCreateTokens =
    raw.cache_creation_input_tokens ??
    raw.cache_write_input_tokens ??
    raw.cacheCreateTokens ??
    raw.cacheWriteTokens;
  const codexInputTokens =
    raw.input_tokens === undefined
      ? undefined
      : Math.max(0, raw.input_tokens - (raw.cached_input_tokens ?? 0));
  const promptInputTokens =
    raw.prompt_tokens === undefined
      ? undefined
      : Math.max(0, raw.prompt_tokens - (raw.prompt_tokens_details?.cached_tokens ?? 0));
  const inputTokens = codexInputTokens ?? promptInputTokens ?? raw.inputTokens;
  const outputTokens = raw.output_tokens ?? raw.completion_tokens ?? raw.outputTokens;
  const reasoningTokens = raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoningTokens;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreateTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return null;
  }

  const normalized = RunnerCallUsageSchema.safeParse({
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheCreateTokens !== undefined && { cacheCreateTokens }),
    ...(reasoningTokens !== undefined && { reasoningTokens }),
  });

  return normalized.success ? normalized.data : null;
}

function copyRunnerCallUsage(usage: RunnerCallUsage): RunnerCallUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined && { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheCreateTokens !== undefined && { cacheCreateTokens: usage.cacheCreateTokens }),
    ...(usage.reasoningTokens !== undefined && { reasoningTokens: usage.reasoningTokens }),
  };
}

function addRunnerCallUsage(
  current: RunnerCallUsage | null,
  next: RunnerCallUsage,
): RunnerCallUsage {
  if (current === null) return copyRunnerCallUsage(next);

  const cacheReadTokens = sumOptional(current.cacheReadTokens, next.cacheReadTokens);
  const cacheCreateTokens = sumOptional(current.cacheCreateTokens, next.cacheCreateTokens);
  const reasoningTokens = sumOptional(current.reasoningTokens, next.reasoningTokens);

  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheCreateTokens !== undefined && { cacheCreateTokens }),
    ...(reasoningTokens !== undefined && { reasoningTokens }),
  };
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}
