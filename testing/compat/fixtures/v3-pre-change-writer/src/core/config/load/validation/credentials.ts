import { PROVIDER_CATALOG } from '../../../providers/catalog.js';
import { isProviderId } from '../../../schemas/enums.js';
import type { Config } from '../../../schemas/config.js';
import { missingRunnerCredential } from '../../accessors/runner-credentials.js';
import {
  customEndpointCredentialSourceError,
  customProviderEnvApiKeyReferenceError,
  missingEnvRefError,
  parseApiKeyEnvRef,
  type RunnerCredentialConfig,
} from '../../credentials.js';
import { apiBaseValidationError } from '../../api-base.js';
import type { ConfigError } from './types.js';

function missingApiKeyError(opts: {
  role: 'planner' | 'implementer';
  path: string;
  config: RunnerCredentialConfig;
}): ConfigError | undefined {
  const { role, path, config } = opts;
  if (config.kind === 'api' || config.kind === 'agent-sdk') {
    const envVar = config.apiKey ? parseApiKeyEnvRef(config.apiKey) : undefined;
    if (envVar && !process.env[envVar]) {
      return missingEnvRefError(path, envVar);
    }
  }

  const missing = missingRunnerCredential(config);
  if (!missing) return undefined;
  const credentialTarget = missing.envVar
    ? `${path}.apiKey or ${missing.envVar} env var`
    : `${path}.apiKey`;

  if (config.kind === 'agent-sdk') {
    return { path: `${path}.apiKey`, message: `Agent SDK requires ${credentialTarget}` };
  }

  return {
    path: `${path}.apiKey`,
    message: `${missing.providerDisplayName} ${role} requires ${credentialTarget}`,
  };
}

function runnerBoundaryErrors(opts: {
  role: 'planner' | 'implementer';
  path: string;
  config: RunnerCredentialConfig;
}): ConfigError[] {
  const errors: ConfigError[] = [];
  const missing = missingApiKeyError(opts);
  if (missing) errors.push(missing);

  if (opts.config.kind === 'api' && opts.config.apiBase) {
    const apiBaseError = apiBaseValidationError(opts.config.apiBase);
    if (apiBaseError) {
      errors.push({
        path: `${opts.path}.apiBase`,
        message: apiBaseError,
        diagnosticState: 'endpoint-invalid',
      });
    }
  }

  const credentialSourceError = customEndpointCredentialSourceError(opts);
  if (credentialSourceError) errors.push(credentialSourceError);

  const customProviderEnvRefError = customProviderEnvApiKeyReferenceError(opts);
  if (customProviderEnvRefError) errors.push(customProviderEnvRefError);

  return errors;
}

function intermediateProviderCredentialErrors(config: Config): ConfigError[] {
  const escalation = config.escalation;
  const provider = escalation?.intermediateProvider;
  if (!provider || escalation.enabled === false) return [];
  if (!isProviderId(provider)) return [];

  const info = PROVIDER_CATALOG[provider];
  if (info.isLocal || !info.apiKeyEnv || process.env[info.apiKeyEnv]) return [];

  return [
    {
      path: 'escalation.intermediateProvider',
      message: `${info.displayName} intermediate provider requires ${info.apiKeyEnv} env var`,
    },
  ];
}

export function apiKeyErrors(config: Config): ConfigError[] {
  const errors: ConfigError[] = [];
  errors.push(
    ...runnerBoundaryErrors({ role: 'planner', path: 'planner', config: config.planner }),
  );
  errors.push(...intermediateProviderCredentialErrors(config));

  if (!config.implementerProfiles) {
    errors.push(
      ...runnerBoundaryErrors({
        role: 'implementer',
        path: 'implementer',
        config: config.implementer,
      }),
    );
    return errors;
  }

  for (const [name, profile] of Object.entries(config.implementerProfiles.profiles)) {
    errors.push(
      ...runnerBoundaryErrors({
        role: 'implementer',
        path: `implementerProfiles.profiles.${name}`,
        config: profile,
      }),
    );
  }

  return errors;
}
