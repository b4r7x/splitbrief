export const BOUNDS = {
  answersPerBrief: 10,
  consultFailingOutputChars: 4000,
  consultDiffChars: 40_000,
  consultAttemptLineChars: 200,
  toolUseCountLimit: 256,
  rateLimitResetWaitMs: 600_000,
  transientRetries: 3,
} as const;
