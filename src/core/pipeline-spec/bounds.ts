export const BOUNDS = {
  consultsPerLineage: 2,
  attemptsPerLineage: 8,
  plannerCallsPerRun: 10,
  extraConsultsPerLineage: 1,
  extraAttemptsPerLineage: 4,
  extraPlannerCallsPerRun: 5,
  extraFixCyclesPerRun: 1,
  consultFailingOutputChars: 4000,
  consultDiffChars: 40_000,
  toolUseCountLimit: 256,
  rateLimitResetWaitMs: 600_000,
  transientRetries: 3,
} as const;
