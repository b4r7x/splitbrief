import { z } from 'zod';
import { admitCliAuthChannel } from './cli-auth-selection.js';
import {
  selectCliAuthChannel,
  type CliAuthChannelId,
  type CliAuthEnforcementEvidence,
  type CliToolId,
} from './cli-tool-catalog.js';
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
 * What a CLI tool's calls bill to, from the method they will actually
 * authenticate on. Only a matrix row for this exact adapter, platform and
 * installed version enforces a method (`admitCliAuthChannel`); every other
 * answer is the tool's own login deciding, and a posture nobody can prove is
 * `unknown` — the same rule `enforceCliAuthInvocation` applies at dispatch.
 * `CLI_AUTH_ENFORCEMENT_EVIDENCE` is empty, so today that is every admitted
 * tool, whether the seat names a method or none.
 */
export function cliBillingPosture(
  input: Readonly<{
    tool: CliToolId;
    authChannel: CliAuthChannelId | undefined;
    installedVersion: string | undefined;
    evidence?: readonly CliAuthEnforcementEvidence[] | undefined;
  }>,
): RunnerBillingPosture {
  const admission = admitCliAuthChannel({
    tool: input.tool,
    platform: process.platform,
    installedVersion: input.installedVersion,
    authChannel: input.authChannel,
    ...(input.evidence !== undefined && { evidence: input.evidence }),
  });
  if (admission.kind !== 'enforced') return 'unknown';
  return selectCliAuthChannel(input.tool, { channel: admission.channel })?.billing ?? 'unknown';
}

/**
 * A seat's posture read from configuration alone. An API runner is billed on
 * the connection SPLITBRIEF opens itself, so its provider names it; a CLI seat
 * names no installed version, so it can prove no method and states no posture.
 */
export function runnerBillingPosture(runner: RunnerConfig): RunnerBillingPosture {
  switch (runner.kind) {
    case 'cli':
      return cliBillingPosture({
        tool: runner.tool,
        authChannel: runner.authChannel,
        installedVersion: undefined,
      });
    case 'api':
      return getApiProviderDescriptor(runner.provider)?.billing ?? 'unknown';
    case 'shell':
    case 'agent':
      return 'unknown';
    default:
      return assertNever(runner);
  }
}
