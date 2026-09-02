import type { CliToolDetection, ProviderDetection } from './detection.js';
import { cloneDetectedModel } from './clone-model.js';

export function cloneCliToolDetection(cli: CliToolDetection): CliToolDetection {
  return {
    ...cli,
    executable:
      cli.executable === null
        ? null
        : {
            path: cli.executable.path,
            fingerprint: { ...cli.executable.fingerprint },
          },
    diagnostic:
      cli.diagnostic.state === 'ready'
        ? { state: 'ready', remediation: null }
        : { state: cli.diagnostic.state, remediation: cli.diagnostic.remediation },
  };
}

export function cloneProviderDetection(provider: ProviderDetection): ProviderDetection {
  return {
    ...provider,
    ...(provider.models === undefined ? {} : { models: provider.models.map(cloneDetectedModel) }),
  };
}
