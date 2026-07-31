import { z } from 'zod';

export const RUNNER_BILLING_POSTURES = [
  'local',
  'subscription-included',
  'api-metered',
  'provider-dependent',
  'unknown',
] as const;

export const RunnerBillingPostureSchema = z.enum(RUNNER_BILLING_POSTURES);
export type RunnerBillingPosture = z.infer<typeof RunnerBillingPostureSchema>;
