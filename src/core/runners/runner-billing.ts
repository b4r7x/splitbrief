import { z } from 'zod';
import type { RunnerConfig } from '../config/accessors/runner-config.js';
import { getApiProviderDescriptor } from '../providers/api-provider-catalog.js';
import { assertNever } from '../../utils/type-guards.js';

export const RUNNER_BILLING_POSTURES = [
  'local',
  'subscription-included',
  'api-metered',
  'provider-dependent',
  'unknown',
] as const;

export const RunnerBillingPostureSchema = z.enum(RUNNER_BILLING_POSTURES);
export type RunnerBillingPosture = z.infer<typeof RunnerBillingPostureSchema>;

const BILLING_WORDS: Readonly<Record<RunnerBillingPosture, string | undefined>> = {
  local: 'local',
  'subscription-included': 'subscription',
  'api-metered': 'metered',
  'provider-dependent': 'provider',
  unknown: undefined,
};

export function billingWord(posture: RunnerBillingPosture): string | undefined {
  return BILLING_WORDS[posture];
}

/**
 * A seat's posture read from configuration alone. An API runner is billed on
 * the connection SPLITBRIEF opens itself, so its provider names it; a CLI seat
 * bills to whatever the tool's own sign-in uses, so it states no posture.
 */
export function runnerBillingPosture(runner: RunnerConfig): RunnerBillingPosture {
  switch (runner.kind) {
    case 'api':
      return getApiProviderDescriptor(runner.provider)?.billing ?? 'unknown';
    case 'cli':
    case 'shell':
    case 'agent':
      return 'unknown';
    default:
      return assertNever(runner);
  }
}
