import type {
  RunnerCallCounterCoverage,
  RunnerCallCounterCoverageState,
} from '../../../core/schemas/runner-call.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { RunnerCallUsageSemantics, RunnerCallUsage } from '../types.js';
import { toTokenDeltaFromRunnerCallUsage } from './normalize.js';

export interface RunnerCallUsageSample {
  readonly semantics: RunnerCallUsageSemantics;
  readonly usage: RunnerCallUsage;
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

export function accumulateTokenUsage(
  current: TokenDelta | null,
  next: TokenDelta,
  semantics: RunnerCallUsageSemantics = 'delta',
): TokenDelta {
  return toTokenDeltaFromRunnerCallUsage(accumulateRunnerCallUsage(current, next, semantics));
}

function copyRunnerCallUsage(usage: RunnerCallUsage): RunnerCallUsage {
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

function addRunnerCallUsage(
  current: RunnerCallUsage | null,
  next: RunnerCallUsage,
): RunnerCallUsage {
  if (current === null) return copyRunnerCallUsage(next);

  const cacheReadTokens = sumOptional(current.cacheReadTokens, next.cacheReadTokens);
  const cacheCreateTokens = sumOptional(current.cacheCreateTokens, next.cacheCreateTokens);
  const reasoningTokens = sumOptional(current.reasoningTokens, next.reasoningTokens);
  const counterCoverage = addCoverage(current.counterCoverage, next.counterCoverage);
  // Inclusive totals describe one provider report, so the sum carries the latest
  // one rather than an accumulation of them.
  const providerTotals = next.providerTotals ?? current.providerTotals;

  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheCreateTokens !== undefined && { cacheCreateTokens }),
    ...(reasoningTokens !== undefined && { reasoningTokens }),
    ...(counterCoverage !== undefined && { counterCoverage }),
    ...(providerTotals !== undefined && { providerTotals: { ...providerTotals } }),
  };
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

// A legacy record carries no coverage at all; summing into it leaves the total
// unknown rather than inventing a description for it.
function addCoverage(
  left: RunnerCallCounterCoverage | undefined,
  right: RunnerCallCounterCoverage | undefined,
): RunnerCallCounterCoverage | undefined {
  if (left === undefined || right === undefined) return undefined;
  return {
    input: combineCoverage(left.input, right.input),
    output: combineCoverage(left.output, right.output),
    cacheRead: combineCoverage(left.cacheRead, right.cacheRead),
    cacheCreate: combineCoverage(left.cacheCreate, right.cacheCreate),
    reasoning: combineCoverage(left.reasoning, right.reasoning),
  };
}

export function combineCoverage(
  left: RunnerCallCounterCoverageState,
  right: RunnerCallCounterCoverageState,
): RunnerCallCounterCoverageState {
  return left === right ? left : 'partial';
}
