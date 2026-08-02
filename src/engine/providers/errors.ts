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
  anthropicNotOpenAICompat: () =>
    error(
      'provider-anthropic-not-openai-compat',
      'Anthropic API is not OpenAI-compatible; use the Anthropic streaming path',
    ),
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
  expectedOpenAIClient: (provider: string) =>
    error(
      'provider-expected-openai-client',
      `Expected OpenAI-compatible client for provider '${provider}'`,
      { provider },
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
  apiBaseExfiltration: (provider: string, envVar: string) =>
    error(
      'provider-api-base-exfiltration',
      `Refusing to send ${envVar} to a custom apiBase for known provider '${provider}'. ` +
        `This combination can exfiltrate API keys. Either remove the apiBase override, ` +
        `or set the API key explicitly in the same config (not via environment variable).`,
      { provider, envVar },
    ),
  admissionOmitRequiresAbsentSource: (relativePath: string) =>
    error(
      'provider-admission-omit-absent-source',
      `Provider admission OMIT requires absent candidate source: ${relativePath}`,
      { relativePath },
    ),
  admissionPassRequiresRetainedSource: (relativePath: string) =>
    error(
      'provider-admission-pass-retained-source',
      `Provider admission PASS requires retained candidate source: ${relativePath}`,
      { relativePath },
    ),
  passCandidateMissingImport: (id: string) =>
    error(
      'provider-pass-candidate-missing-import',
      `PASS verdict ${id} requires a static candidate import in registry.ts`,
      { id },
    ),
  passCandidateMissingCatalog: (id: string) =>
    error(
      'provider-pass-candidate-missing-catalog',
      `PASS verdict ${id} is missing from API_PROVIDER_CATALOG`,
      { id },
    ),
  candidateCatalogMismatch: (message: string, id: string) =>
    error('provider-candidate-catalog-mismatch', message, { id }),
} as const;
