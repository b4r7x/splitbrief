import { PROVIDER_CATALOG } from '../../providers/catalog.js';
import { isProviderId } from '../../schemas/enums.js';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';

type RunnerCredentialConfig = PlannerConfig | ImplementerConfig;

export interface MissingRunnerCredential {
  provider: string;
  providerDisplayName: string;
  envVar?: string | undefined;
}

export function missingRunnerCredential(runner: RunnerCredentialConfig): MissingRunnerCredential | undefined {
  if (runner.kind === 'agent-sdk') {
    const envVar = PROVIDER_CATALOG['agent-sdk']?.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
    if (runner.apiKey || process.env[envVar]) return undefined;
    return {
      provider: 'agent-sdk',
      providerDisplayName: PROVIDER_CATALOG['agent-sdk']?.displayName ?? 'Agent SDK',
      envVar,
    };
  }

  if (runner.kind !== 'api') return undefined;

  if (!isProviderId(runner.provider)) {
    if (runner.apiKey) return undefined;
    return {
      provider: runner.provider,
      providerDisplayName: `Custom provider ${runner.provider}`,
    };
  }

  const info = PROVIDER_CATALOG[runner.provider];
  if (!info.apiKeyEnv || runner.apiKey || process.env[info.apiKeyEnv]) return undefined;
  return {
    provider: runner.provider,
    providerDisplayName: info.displayName,
    envVar: info.apiKeyEnv,
  };
}
