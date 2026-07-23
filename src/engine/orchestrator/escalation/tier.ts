import { runFullTier } from './full.js';
import { runHintTier } from './hint.js';
import { runIntermediateTier } from './intermediate.js';
import type { RetryStepOutcome, TierStepInput } from './types.js';

type TierConfig =
  | { tier: 0; kind: 'intermediate' }
  | { tier: 1; kind: 'hint' }
  | { tier: 2; kind: 'full' };

export const INTERMEDIATE_TIER: TierConfig = { tier: 0, kind: 'intermediate' };
export const HINT_TIER: TierConfig = { tier: 1, kind: 'hint' };
export const FULL_TIER: TierConfig = { tier: 2, kind: 'full' };

export async function runEscalationTier(
  config: TierConfig,
  input: TierStepInput,
): Promise<RetryStepOutcome> {
  if (config.kind === 'intermediate') {
    return runIntermediateTier(input);
  }
  if (config.kind === 'hint') {
    return runHintTier(input);
  }
  const outcome = await runFullTier(input);
  return {
    ...outcome,
    task: input.task,
    lastError: input.lastError,
    attempts: input.priorAttempts + 1,
  };
}
