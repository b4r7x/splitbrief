export const BOUNDS = {
  consultsPerLineage: 2,
  attemptsPerLineage: 8,
  plannerCallsPerRun: 10,
  extraConsultsPerLineage: 1,
  extraAttemptsPerLineage: 4,
  extraPlannerCallsPerRun: 5,
  extraFixCyclesPerRun: 1,
  consultFailingOutputChars: 4000,
  toolUseCountLimit: 256,
  rateLimitResetWaitMs: 600_000,
  transientRetries: 3,
  noProgressCutMs: 1_200_000,
} as const;
