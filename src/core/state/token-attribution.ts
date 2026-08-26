import type { TokenUsage } from '../schemas/tokens.js';
import type { Phase } from '../schemas/enums.js';
import { phaseCostRole } from '../phases.js';

export interface PhaseTokenDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface PhaseTokenAttribution {
  planner: PhaseTokenDelta;
  implementer: PhaseTokenDelta;
  reviewer: PhaseTokenDelta;
}

const ZERO_DELTA: PhaseTokenDelta = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

function clampDelta(value: number): number {
  return Math.max(0, value);
}

export function attributePhaseTokenDelta(
  opts: Readonly<{ previous: TokenUsage; current: TokenUsage; phase: Phase }>,
): PhaseTokenAttribution {
  const { previous, current, phase } = opts;
  const plannerDelta: PhaseTokenDelta = {
    input: clampDelta(
      current.plannerInput -
        previous.plannerInput +
        current.escalationInput -
        previous.escalationInput,
    ),
    output: clampDelta(
      current.plannerOutput -
        previous.plannerOutput +
        current.escalationOutput -
        previous.escalationOutput,
    ),
    cacheRead: clampDelta((current.plannerCacheRead ?? 0) - (previous.plannerCacheRead ?? 0)),
    cacheCreate: clampDelta((current.plannerCacheCreate ?? 0) - (previous.plannerCacheCreate ?? 0)),
  };
  const implementerDelta: PhaseTokenDelta = {
    input: clampDelta(current.implementerInput - previous.implementerInput),
    output: clampDelta(current.implementerOutput - previous.implementerOutput),
    cacheRead: clampDelta(
      (current.implementerCacheRead ?? 0) - (previous.implementerCacheRead ?? 0),
    ),
    cacheCreate: clampDelta(
      (current.implementerCacheCreate ?? 0) - (previous.implementerCacheCreate ?? 0),
    ),
  };
  const reviewerDelta: PhaseTokenDelta = {
    input: clampDelta(current.reviewerInput - previous.reviewerInput),
    output: clampDelta(current.reviewerOutput - previous.reviewerOutput),
    cacheRead: clampDelta((current.reviewerCacheRead ?? 0) - (previous.reviewerCacheRead ?? 0)),
    cacheCreate: clampDelta(
      (current.reviewerCacheCreate ?? 0) - (previous.reviewerCacheCreate ?? 0),
    ),
  };

  const role = phaseCostRole(phase);
  return {
    planner: role === null ? ZERO_DELTA : plannerDelta,
    implementer: role === 'implementer' ? implementerDelta : ZERO_DELTA,
    reviewer: role === null ? ZERO_DELTA : reviewerDelta,
  };
}
