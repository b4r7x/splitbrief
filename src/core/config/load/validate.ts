import { ConfigSchema } from '../../schemas/config.js';
import { PROVIDER_CATALOG, isSameOrigin } from '../../providers/catalog.js';
import { isProviderId } from '../../schemas/enums.js';
import type { Config } from '../../schemas/config.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';
import { missingRunnerCredential } from '../accessors/runner-credentials.js';
import { getRunnerDisplayName, getRunnerApiKey } from '../accessors/runner-config.js';
import { pickDefaultProfileName } from '../accessors/implementer-profiles.js';
import { apiBaseValidationError } from '../api-base.js';
import {
  customEndpointCredentialSourceError,
  isInlineApiKey,
  missingEnvRefError,
  parseApiKeyEnvRef,
  resolveConfiguredApiKey,
  type RunnerCredentialConfig,
} from '../credentials.js';

export interface ConfigError {
  path: string;
  message: string;
}

export interface ConfigValidation {
  errors: ConfigError[];
  warnings: string[];
  data?: Config | undefined;
}

const KEY_FORMAT_HINTS: Record<string, { pattern: RegExp; example: string }> = {
  anthropic: { pattern: /^sk-ant-/, example: 'sk-ant-...' },
  'agent-sdk': { pattern: /^sk-ant-/, example: 'sk-ant-...' },
  openrouter: { pattern: /^sk-or-/, example: 'sk-or-...' },
  deepseek: { pattern: /^sk-/, example: 'sk-...' },
};

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
  skipMissingKey?: boolean | undefined;
}): ConfigError[] {
  const errors: ConfigError[] = [];
  if (!opts.skipMissingKey) {
    const missing = missingApiKeyError(opts);
    if (missing) errors.push(missing);
  }

  if (opts.config.kind === 'api' && opts.config.apiBase) {
    const apiBaseError = apiBaseValidationError(opts.config.apiBase);
    if (apiBaseError) {
      errors.push({ path: `${opts.path}.apiBase`, message: apiBaseError });
    }
  }

  const credentialSourceError = customEndpointCredentialSourceError(opts);
  if (credentialSourceError) errors.push(credentialSourceError);

  return errors;
}

function apiKeyErrors(config: Config): ConfigError[] {
  const errors: ConfigError[] = [];
  errors.push(
    ...runnerBoundaryErrors({ role: 'planner', path: 'planner', config: config.planner }),
  );

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

  const defaultProfileName = selectedImplementerProfileName(config);
  for (const [name, profile] of Object.entries(config.implementerProfiles.profiles)) {
    errors.push(
      ...runnerBoundaryErrors({
        role: 'implementer',
        path: `implementerProfiles.profiles.${name}`,
        config: profile,
        skipMissingKey: name !== defaultProfileName,
      }),
    );
  }

  return errors;
}

function selectedImplementerProfileName(config: Config): string | undefined {
  if (!config.implementerProfiles) return undefined;
  return pickDefaultProfileName(config.implementerProfiles);
}

function keyFormatWarnings(provider: string, key: string): string[] {
  const hint = KEY_FORMAT_HINTS[provider];
  if (!hint || hint.pattern.test(key)) return [];
  return [
    `API key for ${provider} doesn't match expected format (${hint.example}). Verify your key is correct.`,
  ];
}

interface KeyInfo {
  key: string | undefined;
  provider: string | undefined;
  envVar: string | undefined;
  inConfig: boolean;
  envRecommended: boolean;
}

function envRecommendedForApiProvider(provider: string, apiBase: string | undefined): boolean {
  if (!isProviderId(provider)) return false;
  const info = PROVIDER_CATALOG[provider];
  if (!info.apiKeyEnv) return false;
  if (!apiBase || !info.baseURL) return true;
  return isSameOrigin(apiBase, info.baseURL);
}

function plannerKeyInfo(planner: PlannerConfig): KeyInfo {
  switch (planner.kind) {
    case 'agent-sdk': {
      const envVar = PROVIDER_CATALOG['agent-sdk'].apiKeyEnv;
      const envKey = envVar ? process.env[envVar] : undefined;
      return {
        key: resolveConfiguredApiKey(planner.apiKey) ?? envKey,
        provider: 'agent-sdk',
        envVar,
        inConfig: isInlineApiKey(planner.apiKey),
        envRecommended: true,
      };
    }
    case 'api': {
      const envVar = isProviderId(planner.provider)
        ? PROVIDER_CATALOG[planner.provider].apiKeyEnv
        : undefined;
      const envKey = envVar ? process.env[envVar] : undefined;
      return {
        key: resolveConfiguredApiKey(planner.apiKey) ?? envKey,
        provider: planner.provider,
        envVar,
        inConfig: isInlineApiKey(planner.apiKey),
        envRecommended: envRecommendedForApiProvider(planner.provider, planner.apiBase),
      };
    }
    default:
      return {
        key: undefined,
        provider: undefined,
        envVar: undefined,
        inConfig: false,
        envRecommended: false,
      };
  }
}

function implementerKeyInfo(implementer: ImplementerConfig): KeyInfo {
  const provider = getRunnerDisplayName(implementer);
  const providerId = isProviderId(provider) ? provider : undefined;
  const envVar = providerId ? PROVIDER_CATALOG[providerId].apiKeyEnv : undefined;
  const envKey = envVar ? process.env[envVar] : undefined;
  const apiKey = getRunnerApiKey(implementer);
  const apiBase = implementer.kind === 'api' ? implementer.apiBase : undefined;
  return {
    key: resolveConfiguredApiKey(apiKey) ?? envKey,
    provider: providerId,
    envVar,
    inConfig: isInlineApiKey(apiKey),
    envRecommended: providerId ? envRecommendedForApiProvider(providerId, apiBase) : false,
  };
}

function keyInfoWarnings(role: string, info: KeyInfo): string[] {
  const warnings: string[] = [];
  if (info.inConfig && info.envVar && info.envRecommended) {
    warnings.push(
      `API key found in ${role} config. For better security, set ${info.envVar} environment variable and remove apiKey from config.`,
    );
  }
  if (info.key && info.provider && isInlineApiKey(info.key)) {
    warnings.push(...keyFormatWarnings(info.provider, info.key));
  }
  return warnings;
}

export function securityWarnings(config: Config): string[] {
  const warnings: string[] = [];

  for (const [role, info] of [
    ['planner', plannerKeyInfo(config.planner)],
    ['implementer', implementerKeyInfo(config.implementer)],
  ] as const) {
    warnings.push(...keyInfoWarnings(role, info));
  }

  for (const [name, profile] of Object.entries(config.implementerProfiles?.profiles ?? {})) {
    warnings.push(...keyInfoWarnings(`implementer profile ${name}`, implementerKeyInfo(profile)));
  }

  warnings.push(...profileCredentialWarnings(config));

  return warnings;
}

function profileCredentialWarnings(config: Config): string[] {
  const defaultName = selectedImplementerProfileName(config);
  if (defaultName === undefined) return [];

  return Object.entries(config.implementerProfiles?.profiles ?? {}).flatMap(([name, profile]) => {
    const error = missingApiKeyError({
      role: 'implementer',
      path: `implementerProfiles.profiles.${name}`,
      config: profile,
    });
    if (!error) return [];
    if (name === defaultName) return [];

    return [
      `Non-default implementer profile ${name} is missing credentials; it will be skipped by automatic task routing until credentials are configured: ${error.message}.`,
    ];
  });
}

export function validateConfig(config: Record<string, unknown>): ConfigValidation {
  const result = ConfigSchema.safeParse(config);

  const errors: ConfigError[] = [];

  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push({
        path: issue.path.join('.'),
        message: issue.message,
      });
    }
  }

  if (result.success) {
    errors.push(...apiKeyErrors(result.data));
  }

  const warnings = result.success ? securityWarnings(result.data) : [];

  return { errors, warnings, data: result.success ? result.data : undefined };
}
