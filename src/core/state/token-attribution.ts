import type { TokenUsage } from '../schemas/tokens.js';
import type { Phase } from '../schemas/enums.js';
import { phaseCostRole } from '../phases.js';

export interface TokenDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface PhaseTokenAttribution {
  planner: TokenDelta;
  implementer: TokenDelta;
}

const ZERO_DELTA: TokenDelta = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

function clampDelta(value: number): number {
  return Math.max(0, value);
}

export function attributePhaseTokenDelta(
  prev: TokenUsage,
  curr: TokenUsage,
  phase: Phase,
): PhaseTokenAttribution {
  const plannerDelta: TokenDelta = {
    input: clampDelta(
      curr.plannerInput - prev.plannerInput + curr.escalationInput - prev.escalationInput,
    ),
    output: clampDelta(
      curr.plannerOutput - prev.plannerOutput + curr.escalationOutput - prev.escalationOutput,
    ),
    cacheRead: clampDelta((curr.plannerCacheRead ?? 0) - (prev.plannerCacheRead ?? 0)),
    cacheCreate: clampDelta((curr.plannerCacheCreate ?? 0) - (prev.plannerCacheCreate ?? 0)),
  };
  const implementerDelta: TokenDelta = {
    input: clampDelta(curr.implementerInput - prev.implementerInput),
    output: clampDelta(curr.implementerOutput - prev.implementerOutput),
    cacheRead: clampDelta((curr.implementerCacheRead ?? 0) - (prev.implementerCacheRead ?? 0)),
    cacheCreate: clampDelta(
      (curr.implementerCacheCreate ?? 0) - (prev.implementerCacheCreate ?? 0),
    ),
  };

  const role = phaseCostRole(phase);
  return {
    planner: role === null ? ZERO_DELTA : plannerDelta,
    implementer: role === 'implementer' ? implementerDelta : ZERO_DELTA,
  };
}
