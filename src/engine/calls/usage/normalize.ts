import { z } from 'zod';
import {
  RunnerCallCounterCoverageSchema,
  RunnerCallProviderTotalsSchema,
  type RunnerCallCounterCoverage,
  type RunnerCallProviderTotals,
  type RunnerCallCounterCoverageState,
} from '../../../core/schemas/runner-call.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { RunnerCallUsageSchema } from '../schema.js';
import type { RunnerCallUsage } from '../types.js';

const tokenCount = z.number().int().nonnegative();

const PromptTokensDetailsSchema = z.looseObject({
  cached_tokens: tokenCount.optional(),
  cache_write_tokens: tokenCount.optional(),
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
  counterCoverage: RunnerCallCounterCoverageSchema.optional(),
  providerTotals: RunnerCallProviderTotalsSchema.optional(),
});

type BackendTokenUsage = z.infer<typeof BackendTokenUsageSchema>;

export function normalizeRunnerCallUsage(raw: unknown): RunnerCallUsage | null {
  const parsed = BackendTokenUsageSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (isCanonicalUsageShape(parsed.data)) {
    const cacheCreateTokens = parsed.data.cacheCreateTokens ?? parsed.data.cacheWriteTokens;
    const canonical = RunnerCallUsageSchema.strip().safeParse({
      ...(parsed.data.inputTokens !== undefined && { inputTokens: parsed.data.inputTokens }),
      ...(parsed.data.outputTokens !== undefined && { outputTokens: parsed.data.outputTokens }),
      ...(parsed.data.cacheReadTokens !== undefined && {
        cacheReadTokens: parsed.data.cacheReadTokens,
      }),
      ...(cacheCreateTokens !== undefined && { cacheCreateTokens }),
      ...(parsed.data.reasoningTokens !== undefined && {
        reasoningTokens: parsed.data.reasoningTokens,
      }),
      ...(parsed.data.counterCoverage !== undefined && {
        counterCoverage: parsed.data.counterCoverage,
      }),
      ...(parsed.data.providerTotals !== undefined && {
        providerTotals: parsed.data.providerTotals,
      }),
    });
    return canonical.success ? canonical.data : null;
  }
  return normalizeParsedUsage(parsed.data);
}

/**
 * Normalize the object a provider just emitted. Provider aliases carry the
 * inclusive totals and their coverage can only be established while those
 * aliases are still present. Persisted RunnerCallUsage objects use the
 * canonical path above so replay never subtracts a split twice.
 */
export function normalizeProviderTokenUsage(raw: unknown): RunnerCallUsage | null {
  const parsed = BackendTokenUsageSchema.safeParse(raw);
  return parsed.success ? normalizeParsedUsage(parsed.data) : null;
}

export function toTokenDelta(raw: unknown): TokenDelta | null {
  const usage = normalizeRunnerCallUsage(raw);
  return usage === null ? null : toTokenDeltaFromRunnerCallUsage(usage);
}

export function toProviderTokenDelta(raw: unknown): TokenDelta | null {
  const usage = normalizeProviderTokenUsage(raw);
  return usage === null ? null : toTokenDeltaFromRunnerCallUsage(usage);
}

export function toTokenDeltaFromRunnerCallUsage(usage: RunnerCallUsage): TokenDelta {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined && { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheCreateTokens !== undefined && { cacheCreateTokens: usage.cacheCreateTokens }),
    ...(usage.reasoningTokens !== undefined && { reasoningTokens: usage.reasoningTokens }),
    ...(usage.counterCoverage !== undefined && { counterCoverage: { ...usage.counterCoverage } }),
    ...(usage.providerTotals !== undefined && { providerTotals: { ...usage.providerTotals } }),
  };
}

export function runnerCallTokenDelta(usage: RunnerCallUsage | null): TokenDelta | null {
  if (usage === null) return null;
  return toTokenDeltaFromRunnerCallUsage(usage);
}

function normalizeParsedUsage(raw: BackendTokenUsage): RunnerCallUsage | null {
  // Snake-case subcounters are carved out of an inclusive provider total, so they
  // are subtracted from it. camelCase counters come from our own contract, where
  // the totals are already disjoint, and are never subtracted a second time.
  const reportedCacheRead =
    raw.cache_read_input_tokens ??
    raw.cached_input_tokens ??
    raw.prompt_tokens_details?.cached_tokens;
  const reportedCacheCreate =
    raw.cache_creation_input_tokens ??
    raw.cache_write_input_tokens ??
    raw.prompt_tokens_details?.cache_write_tokens;
  const reportedReasoning = raw.completion_tokens_details?.reasoning_tokens;

  const cacheReadTokens = reportedCacheRead ?? raw.cacheReadTokens;
  const cacheCreateTokens = reportedCacheCreate ?? raw.cacheCreateTokens ?? raw.cacheWriteTokens;
  const reasoningTokens = reportedReasoning ?? raw.reasoningTokens;

  // input_tokens wins over prompt_tokens, so the count, its inclusive total and
  // its coverage all read the same field. prompt_tokens is inclusive of cache
  // reads and cache writes; input_tokens is inclusive only alongside the
  // documented cached_input_tokens (Codex), never by name similarity alone.
  const promptTokens = raw.input_tokens === undefined ? raw.prompt_tokens : undefined;
  const inclusiveInputTotal =
    promptTokens ?? (raw.cached_input_tokens === undefined ? undefined : raw.input_tokens);
  const inclusiveOutputTotal = raw.output_tokens ?? raw.completion_tokens;

  const codexInputTokens =
    raw.input_tokens === undefined ? undefined : raw.input_tokens - (raw.cached_input_tokens ?? 0);
  const promptInputTokens =
    promptTokens === undefined
      ? undefined
      : promptTokens - (reportedCacheRead ?? 0) - (reportedCacheCreate ?? 0);
  const inputTokens = codexInputTokens ?? promptInputTokens ?? raw.inputTokens;
  const outputTokens =
    inclusiveOutputTotal === undefined
      ? raw.outputTokens
      : inclusiveOutputTotal - (reportedReasoning ?? 0);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreateTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return null;
  }

  // A subcategory larger than the total that contains it does not describe a
  // call; clamping it to zero would report a conserved split that never existed.
  if ((inputTokens ?? 0) < 0 || (outputTokens ?? 0) < 0) return null;

  const cacheReadCoverage = observedCoverage(cacheReadTokens);
  const cacheCreateCoverage = observedCoverage(cacheCreateTokens);
  const reasoningCoverage = observedCoverage(reasoningTokens);
  // cached_input_tokens is the only subcategory folded into the Codex input
  // total, and taking that path already proves it was reported.
  const inputSubcountersReported =
    promptTokens === undefined ||
    (reportedCacheRead !== undefined && reportedCacheCreate !== undefined);
  const counterCoverage: RunnerCallCounterCoverage = {
    input: derivedCoverage(
      inputTokens,
      inclusiveInputTotal !== undefined,
      inputSubcountersReported,
    ),
    output: derivedCoverage(
      outputTokens,
      inclusiveOutputTotal !== undefined,
      reportedReasoning !== undefined,
    ),
    cacheRead: cacheReadCoverage,
    cacheCreate: cacheCreateCoverage,
    reasoning: reasoningCoverage,
  };

  const providerTotals: RunnerCallProviderTotals = {
    ...(inclusiveInputTotal !== undefined && { input: inclusiveInputTotal }),
    ...(inclusiveOutputTotal !== undefined && { output: inclusiveOutputTotal }),
  };

  const normalized = RunnerCallUsageSchema.safeParse({
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheCreateTokens !== undefined && { cacheCreateTokens }),
    ...(reasoningTokens !== undefined && { reasoningTokens }),
    counterCoverage,
    ...(Object.keys(providerTotals).length > 0 && { providerTotals }),
  });

  return normalized.success ? normalized.data : null;
}

function isCanonicalUsageShape(raw: BackendTokenUsage): boolean {
  if (
    raw.input_tokens !== undefined ||
    raw.output_tokens !== undefined ||
    raw.cached_input_tokens !== undefined ||
    raw.cache_read_input_tokens !== undefined ||
    raw.cache_write_input_tokens !== undefined ||
    raw.cache_creation_input_tokens !== undefined ||
    raw.prompt_tokens !== undefined ||
    raw.completion_tokens !== undefined ||
    raw.prompt_tokens_details !== undefined ||
    raw.completion_tokens_details !== undefined ||
    raw.cacheWriteTokens !== undefined
  ) {
    return false;
  }

  return (
    raw.counterCoverage !== undefined ||
    raw.providerTotals !== undefined ||
    (raw.inputTokens !== undefined && raw.outputTokens !== undefined)
  );
}

function observedCoverage(value: number | undefined): RunnerCallCounterCoverageState {
  return value === undefined ? 'missing' : 'reported';
}

// A count carved out of an inclusive provider total is only exact when every
// subcategory folded into that total was itself reported.
function derivedCoverage(
  value: number | undefined,
  fromInclusiveTotal: boolean,
  subcountersReported: boolean,
): RunnerCallCounterCoverageState {
  if (value === undefined) return 'missing';
  if (fromInclusiveTotal && !subcountersReported) return 'partial';
  return 'reported';
}
