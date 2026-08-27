import { PROVIDER_CATALOG, isSameOrigin } from '../../../providers/catalog.js';
import { isProviderId } from '../../../schemas/enums.js';
import type { Config } from '../../../schemas/config.js';
import type { ImplementerConfig } from '../../../schemas/implementer-config.js';
import type { PlannerConfig } from '../../../schemas/planner-config.js';
import { commandName, isShellEvaluatedPromptArg } from '../../../trust/path-classification.js';
import { configuredReviewerRunner } from '../../accessors/reviewer-runner.js';
import { getRunnerDisplayName, getRunnerApiKey } from '../../accessors/runner-config.js';
import { isInlineApiKey, resolveConfiguredApiKey } from '../../credentials.js';

const KEY_FORMAT_HINTS: Record<string, { pattern: RegExp; example: string }> = {
  anthropic: { pattern: /^sk-ant-/, example: 'sk-ant-...' },
  'agent-sdk': { pattern: /^sk-ant-/, example: 'sk-ant-...' },
  openrouter: { pattern: /^sk-or-/, example: 'sk-or-...' },
  deepseek: { pattern: /^sk-/, example: 'sk-...' },
};

const PROMPT_PLACEHOLDER = '{prompt}';

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
      `Inline API key in ${role} config. Migrate it: export ${info.envVar} in your shell, then remove the apiKey entry from .splitbrief/config.yaml.`,
    );
  }
  if (info.key && info.provider) {
    warnings.push(...keyFormatWarnings(info.provider, info.key));
  }
  return warnings;
}

function runnerPromptPlaceholderArgWarnings(
  label: string,
  runner: PlannerConfig | ImplementerConfig,
): string[] {
  if (runner.kind !== 'shell' && runner.kind !== 'agent') return [];
  const args = runner.args ?? [];
  if (!args.some((arg) => arg.includes(PROMPT_PLACEHOLDER))) return [];

  if (isShellEvaluatedPromptArg(runner.command, args)) {
    return [
      `${label}.args passes {prompt} through ${commandName(runner.command)} -c. Placeholder-enabled runs shell-evaluate prompt text there; prefer stdin or a non-shell argv placeholder.`,
    ];
  }

  return [
    `${label}.args contains {prompt}. Placeholder args are allowed, but placeholder-enabled runners pass prompt text through argv; prefer stdin when possible.`,
  ];
}

function promptPlaceholderArgWarnings(config: Config): string[] {
  const warnings: string[] = [];
  warnings.push(...runnerPromptPlaceholderArgWarnings('planner', config.planner));
  warnings.push(...runnerPromptPlaceholderArgWarnings('implementer', config.implementer));
  const reviewer = configuredReviewerRunner(config);
  if (reviewer !== undefined) {
    warnings.push(...runnerPromptPlaceholderArgWarnings('reviewer', reviewer));
  }

  for (const [name, profile] of Object.entries(config.implementerProfiles?.profiles ?? {})) {
    warnings.push(...runnerPromptPlaceholderArgWarnings(`implementer profile ${name}`, profile));
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

  const reviewer = configuredReviewerRunner(config);
  if (reviewer !== undefined) {
    warnings.push(...keyInfoWarnings('reviewer', plannerKeyInfo(reviewer)));
  }

  for (const [name, profile] of Object.entries(config.implementerProfiles?.profiles ?? {})) {
    warnings.push(...keyInfoWarnings(`implementer profile ${name}`, implementerKeyInfo(profile)));
  }

  warnings.push(...promptPlaceholderArgWarnings(config));

  return warnings;
}
