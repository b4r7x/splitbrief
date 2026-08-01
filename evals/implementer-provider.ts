import { PENDING_EVALUATION_CANDIDATE_IDS } from '../src/core/providers/known-models.js';
import type { ProviderId } from '../src/core/schemas/enums.js';

export const MODEL_EVALUATION_SCENARIO_IDS = Object.freeze([
  'typescript-fix',
  'multi-file-esm',
  'react-no-memo',
  'behavior-test',
  'near-limit-brief',
] as const);

export type ModelEvaluationScenarioId = (typeof MODEL_EVALUATION_SCENARIO_IDS)[number];

export const MODEL_EVALUATION_THRESHOLDS = Object.freeze({
  compileTest: { passed: 5, total: 5 },
  extraction: { passed: 5, total: 5 },
  instructionAdherence: { passed: 5, total: 5 },
  maxUnnecessaryFiles: 0,
  maxRetryRate: 0.2,
} as const);

export type ModelEvaluationScenarioMetrics = {
  compileTest: { passed: number; total: 5 };
  extraction: { passed: number; total: 5 };
  instructionAdherence: { passed: number; total: 5 };
  unnecessaryFiles: number;
  retryRate: number;
};

export type ModelEvaluationScenarioResult = {
  scenarioId: ModelEvaluationScenarioId;
  metrics: ModelEvaluationScenarioMetrics;
  thresholdsMet: boolean;
};

export type PendingEvaluationCandidate = {
  provider: ProviderId;
  model: string;
};

export type ModelEvaluationOmitRow = {
  resolution: 'OMIT-NOT-APPLICABLE';
  taskId: 'T-080';
  provider: ProviderId;
  model: string;
  reason: string;
};

export type OmitProviderEvaluationRow = {
  resolution: 'OMIT-NOT-APPLICABLE';
  taskId:
    | 'T-043'
    | 'T-044'
    | 'T-045'
    | 'T-046'
    | 'T-047'
    | 'T-048'
    | 'T-049'
    | 'T-050'
    | 'T-051'
    | 'T-052'
    | 'T-053';
  provider: string;
  reason: string;
};

export type ModelEvaluationEvidence = {
  asOf: string;
  scenarioIds: readonly ModelEvaluationScenarioId[];
  thresholds: typeof MODEL_EVALUATION_THRESHOLDS;
  modelEvaluationRows: readonly ModelEvaluationOmitRow[];
  omitRows: readonly OmitProviderEvaluationRow[];
};

export const OMIT_PROVIDER_EVALUATION_ROWS = Object.freeze([
  {
    resolution: 'OMIT-NOT-APPLICABLE',
    taskId: 'T-043',
    provider: 'deepseek',
    reason: 'provider verdict OMIT at T-043; no pending-evaluation model',
  },
  {
    resolution: 'OMIT-NOT-APPLICABLE',
    taskId: 'T-044',
    provider: 'mistral',
    reason: 'provider verdict OMIT at T-044; no pending-evaluation model',
  },
  {
    resolution: 'OMIT-NOT-APPLICABLE',
    taskId: 'T-045',
    provider: 'gemini',
    reason: 'provider verdict OMIT at T-045; no pending-evaluation model',
  },
  {
    resolution: 'OMIT-NOT-APPLICABLE',
    taskId: 'T-046',
    provider: 'cerebras',
    reason: 'provider verdict OMIT at T-046; no pending-evaluation model',
  },
  {
    resolution: 'OMIT-NOT-APPLICABLE',
    taskId: 'T-047',
    provider: 'zai',
    reason: 'provider verdict OMIT at T-047; no pending-evaluation model',
  },
  {
    resolution: 'OMIT-NOT-APPLICABLE',
    taskId: 'T-048',
    provider: 'mimo',
    reason: 'provider verdict OMIT at T-048; no pending-evaluation model',
  },
  {
    resolution: 'OMIT-NOT-APPLICABLE',
    taskId: 'T-049',
    provider: 'mimo-token-plan',
    reason: 'provider verdict OMIT at T-049; no pending-evaluation model',
  },
  {
    resolution: 'OMIT-NOT-APPLICABLE',
    taskId: 'T-050',
    provider: 'minimax',
    reason: 'provider verdict OMIT at T-050; no pending-evaluation model',
  },
  {
    resolution: 'OMIT-NOT-APPLICABLE',
    taskId: 'T-051',
    provider: 'moonshot',
    reason: 'provider verdict OMIT at T-051; no pending-evaluation model',
  },
  {
    resolution: 'OMIT-NOT-APPLICABLE',
    taskId: 'T-052',
    provider: 'dashscope',
    reason: 'provider verdict OMIT at T-052; no pending-evaluation model',
  },
  {
    resolution: 'OMIT-NOT-APPLICABLE',
    taskId: 'T-053',
    provider: 'llama-cpp',
    reason: 'provider verdict OMIT at T-053; no pending-evaluation model',
  },
] as const satisfies readonly OmitProviderEvaluationRow[]);

/**
 * T-080 measures five extracted-code scenarios against a live model. No such run
 * exists, so every pending candidate records OMIT-NOT-APPLICABLE instead of a
 * score, and its runtime row stays `compatible-only`. Recording invented metrics
 * here would let an unmeasured model reach users as `recommended`.
 */
const UNEVALUATED_REASON =
  'no credentialed five-scenario extracted-code run was executed; runtime recommendation stays compatible-only';

export const MODEL_EVALUATION_OMIT_ROWS: readonly ModelEvaluationOmitRow[] = Object.freeze(
  PENDING_EVALUATION_CANDIDATE_IDS.map(
    ({ provider, model }): ModelEvaluationOmitRow => ({
      resolution: 'OMIT-NOT-APPLICABLE',
      taskId: 'T-080',
      provider,
      model,
      reason: UNEVALUATED_REASON,
    }),
  ),
);

const EVIDENCE_AS_OF = '2026-07-31';

export function discoverPendingEvaluationCandidates(): readonly PendingEvaluationCandidate[] {
  return PENDING_EVALUATION_CANDIDATE_IDS;
}

export function scenarioMetricsMeetThresholds(metrics: ModelEvaluationScenarioMetrics): boolean {
  return (
    metrics.compileTest.passed >= MODEL_EVALUATION_THRESHOLDS.compileTest.passed &&
    metrics.extraction.passed >= MODEL_EVALUATION_THRESHOLDS.extraction.passed &&
    metrics.instructionAdherence.passed >=
      MODEL_EVALUATION_THRESHOLDS.instructionAdherence.passed &&
    metrics.unnecessaryFiles <= MODEL_EVALUATION_THRESHOLDS.maxUnnecessaryFiles &&
    metrics.retryRate <= MODEL_EVALUATION_THRESHOLDS.maxRetryRate
  );
}

export function deriveQualityVerdict(
  scenarios: readonly ModelEvaluationScenarioResult[],
): 'PASS' | 'FAIL' {
  if (scenarios.length !== MODEL_EVALUATION_SCENARIO_IDS.length) return 'FAIL';
  return scenarios.every((scenario) => scenario.thresholdsMet) ? 'PASS' : 'FAIL';
}

export function buildModelEvaluationEvidence(
  asOf: string = EVIDENCE_AS_OF,
): ModelEvaluationEvidence {
  return {
    asOf,
    scenarioIds: MODEL_EVALUATION_SCENARIO_IDS,
    thresholds: MODEL_EVALUATION_THRESHOLDS,
    modelEvaluationRows: MODEL_EVALUATION_OMIT_ROWS,
    omitRows: OMIT_PROVIDER_EVALUATION_ROWS,
  };
}
