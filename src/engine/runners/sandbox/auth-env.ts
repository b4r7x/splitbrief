import { getApiProviderDescriptor } from '../../../core/providers/api-catalog.js';
import {
  type CliAuthChannel,
  type CliHostStateAccess,
  cliAuthChannelHostStateAccess,
} from '../../../core/runners/cli-tool/auth-channels.js';
import { defaultCliAuthChannel } from '../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import type { ImplementerConfig } from '../../../core/schemas/runner/implementer.js';
import type { PlannerConfig } from '../../../core/schemas/runner/planner.js';
import { apiKeyEnvReference } from '../../providers/client/api-key.js';

export type RunnerLike = PlannerConfig | ImplementerConfig;

const PROVIDER_API_KEY_ENV_RE = /_API_KEY$/;

/**
 * The host environment variables a staged child keeps for an auth channel —
 * one rule for the catalog probe, for readiness, and for dispatch, so a model
 * the picker lists is a model the runner can actually run. A provider-dependent
 * tool holds no credential of its own: opencode and kilo use whichever
 * providers the user's own shell has keys for, so preserving only the channel's
 * declared keys strands the credential the listing was built from. Those
 * channels keep every `*_API_KEY` the process carries; every other channel
 * keeps exactly the keys it declares.
 */
export function cliAuthChannelEnvKeys(
  channel: CliAuthChannel | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const declared = [...(channel?.env ?? [])];
  if (channel?.billing !== 'provider-dependent') return declared;
  const passthrough = Object.keys(processEnv).filter((key) => PROVIDER_API_KEY_ENV_RE.test(key));
  return [...new Set([...declared, ...passthrough])];
}

export type CliChannelStaging = Readonly<{
  selectedCli: CliToolId | undefined;
  hostState: CliHostStateAccess;
  preserveEnvKeys: string[];
}>;

/**
 * How a child of `tool` is staged for its auth channel. Readiness, the catalog
 * probe and dispatch all build their environment from this one staging, so
 * what a probe verified is what the runner is handed. A channel keeps only
 * its own credential path: the environment variables it declares and the host
 * state it reaches. No channel (the version probe) stages no tool state at all.
 */
export function cliChannelStaging(
  tool: CliToolId,
  channel: CliAuthChannel | undefined,
): CliChannelStaging {
  if (channel === undefined) {
    return { selectedCli: undefined, hostState: 'none', preserveEnvKeys: [] };
  }
  return {
    selectedCli: tool,
    hostState: cliAuthChannelHostStateAccess(channel),
    preserveEnvKeys: cliAuthChannelEnvKeys(channel),
  };
}

export function runnerAuthEnvKeys(runner: RunnerLike): string[] {
  const keys = new Set<string>();
  if ('apiKey' in runner) {
    const ref = apiKeyEnvReference(runner.apiKey);
    if (ref) keys.add(ref);
  }
  switch (runner.kind) {
    case 'api': {
      const descriptor = getApiProviderDescriptor(runner.provider);
      if (descriptor?.credentialEnv) keys.add(descriptor.credentialEnv);
      break;
    }
    case 'cli': {
      for (const envVar of cliAuthChannelEnvKeys(defaultCliAuthChannel(runner.tool)))
        keys.add(envVar);
      break;
    }
    case 'shell':
    case 'agent': {
      for (const envVar of runner.env ?? []) keys.add(envVar);
      break;
    }
  }
  return [...keys];
}
