import { runHintTier } from './hint.js';
import { runIntermediateTier } from './intermediate.js';
import type { RetryStepOutcome, TierStepInput } from './types.js';

type TierConfig = { tier: 0; kind: 'intermediate' } | { tier: 1; kind: 'hint' };

export const INTERMEDIATE_TIER: TierConfig = { tier: 0, kind: 'intermediate' };
export const HINT_TIER: TierConfig = { tier: 1, kind: 'hint' };

export async function runEscalationTier(
  config: TierConfig,
  input: TierStepInput,
): Promise<RetryStepOutcome> {
  if (config.kind === 'intermediate') {
    return runIntermediateTier(input);
  }
  return runHintTier(input);
}
