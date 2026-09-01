import { error } from '../../utils/error.js';
import { redactSecrets } from '../../utils/redact.js';

export const providerError = {
  unknownNeedsApiBase: (name: string) =>
    error(
      'provider-unknown-needs-api-base',
      `Unknown provider '${name}' requires an apiBase override`,
      { name },
    ),
  unknownNeedsApiKey: (name: string) =>
    error(
      'provider-unknown-needs-api-key',
      `Unknown provider '${name}' requires an overrides.apiKey`,
      { name },
    ),
  notApi: (kind: string) =>
    error('provider-not-api', `getImplementerProvider requires kind=api, got kind=${kind}`, {
      kind,
    }),
  missingModel: (role: 'planner' | 'implementer') =>
    error(
      'provider-missing-model',
      `API ${role} requires an explicit model ID. Set ${role}.model, or use "auto" only with a provider that has a catalog default.`,
      { role },
    ),
  promptExceedsContext: (
    promptTokens: number,
    contextLength: number,
    role: 'planner' | 'implementer' = 'implementer',
  ) =>
    error(
      'provider-prompt-exceeds-context',
      `Prompt (${promptTokens} tokens) leaves no room for output within the ${contextLength}-token context window. ` +
        `Raise ${role}.contextLength or reduce the task context.`,
      { promptTokens, contextLength },
    ),
  httpFailure: (status: number, url: string) =>
    error('provider-http-failure', `HTTP ${status}`, { status, url }),
  invalidApiBase: (apiBase: string, reason: string) =>
    error('provider-invalid-api-base', `Invalid apiBase '${redactSecrets(apiBase)}': ${reason}`, {
      apiBase: redactSecrets(apiBase),
      reason,
    }),
  apiKeyEnvMissing: (envVar: string) =>
    error(
      'provider-api-key-env-missing',
      `Configured apiKey references ${envVar}, but that environment variable is not set`,
      { envVar },
    ),
  invalidApiKeyEnvReference: () =>
    error(
      'provider-invalid-api-key-env-reference',
      'Invalid apiKey env reference; expected env:VARIABLE_NAME',
    ),
  ollamaLocalCredentialReference: () =>
    error(
      'provider-ollama-local-credential-invalid',
      'Local Ollama accepts no apiKey or exactly env:OLLAMA_LOCAL_API_KEY',
    ),
} as const;
