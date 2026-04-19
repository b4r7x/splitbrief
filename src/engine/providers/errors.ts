import { error } from '../../utils/error.js';

export const providerError = {
  unknownNeedsApiBase: (name: string) =>
    error('provider-unknown-needs-api-base', `Unknown provider '${name}' requires an apiBase override`, { name }),
  unknownNeedsApiKey: (name: string) =>
    error('provider-unknown-needs-api-key', `Unknown provider '${name}' requires an overrides.apiKey`, { name }),
  notApi: (kind: string) =>
    error('provider-not-api', `getImplementerProvider requires kind=api, got kind=${kind}`, { kind }),
  anthropicNotOpenAICompat: () =>
    error(
      'provider-anthropic-not-openai-compat',
      'Anthropic API is not OpenAI-compatible; use the Anthropic streaming path',
    ),
  missingModel: (role: 'planner' | 'implementer') =>
    error(
      'provider-missing-model',
      `API ${role} requires an explicit model name — 'auto' is not supported for API backends. Set ${role}.model in your config.`,
      { role },
    ),
  expectedOpenAIClient: (provider: string) =>
    error('provider-expected-openai-client', `Expected OpenAI-compatible client for provider '${provider}'`, { provider }),
  httpFailure: (status: number, url: string) =>
    error('provider-http-failure', `HTTP ${status}`, { status, url }),
} as const;
