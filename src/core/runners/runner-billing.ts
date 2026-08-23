import { z } from 'zod';
import { CLI_TOOL_CATALOG, defaultCliAuthChannel } from './cli-tool-catalog.js';
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

export function runnerBillingPosture(runner: RunnerConfig): RunnerBillingPosture {
  switch (runner.kind) {
    case 'cli': {
      const declaration = CLI_TOOL_CATALOG[runner.tool];
      const channelId = runner.authChannel ?? defaultCliAuthChannel(runner.tool).id;
      return (
        declaration.auth.channels.find((channel) => channel.id === channelId)?.billing ??
        declaration.billing
      );
    }
    case 'api':
      return getApiProviderDescriptor(runner.provider)?.billing ?? 'unknown';
    case 'agent-sdk':
      return 'api-metered';
    case 'shell':
    case 'agent':
      return 'unknown';
    default:
      return assertNever(runner);
  }
}
