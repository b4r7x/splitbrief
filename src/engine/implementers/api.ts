import type { Config, ApiImplementerConfig } from '../../types.js';
import type { Implementer, ImplementerOptions, RetryOptions } from './types.js';
import type { InvokeOpts } from './utils.js';
import { createImplementerBase } from './base.js';
import { createClient } from '../providers/registry.js';
import { formatTaskPrompt, formatRetryPrompt, SYSTEM_PREAMBLE } from '../spec/formatter.js';
import { estimateTokens } from '../spec/token-budget.js';
import { resolveAutoModel, PROVIDER_CATALOG, isProviderId } from '../../core/providers.js';
import { assertImplementerKind } from './utils.js';
import { streamApiCompletion, throwAutoModelError } from '../api-shared.js';

function asApiConfig(config: Config): ApiImplementerConfig {
  return assertImplementerKind(config, 'api');
}

export function createApiImplementer(initialConfig: Config): Implementer {
  asApiConfig(initialConfig);

  return createImplementerBase({
    extractsCode: true,
    // API backends send SYSTEM_PREAMBLE as a separate system message
    prependSystemPreamble: false,

    async invoke(opts: InvokeOpts) {
      const { prompt, config, onOutput, signal } = opts;
      const impl = asApiConfig(config);
      const temperature = opts.temperature ?? impl.temperature ?? 0.7;
      const contextLength = impl.contextLength ?? 8192;

      const promptTokens = estimateTokens(SYSTEM_PREAMBLE) + estimateTokens(prompt);
      const available = contextLength - promptTokens;
      const maxTokens = Math.min(Math.max(available, 1024), contextLength);

      const model = resolveAutoModel(impl.model, impl.provider);
      if (!model) throwAutoModelError('implementer');

      const client = impl.provider === 'anthropic' ? null : createClient(config);

      const providerEnvKey = isProviderId(impl.provider) ? PROVIDER_CATALOG[impl.provider]?.apiKeyEnv : undefined;
      const resolvedApiKey = impl.apiKey ?? (providerEnvKey ? process.env[providerEnvKey] : undefined) ?? '';

      return streamApiCompletion({
        client,
        provider: impl.provider,
        apiBase: impl.apiBase,
        apiKey: resolvedApiKey,
        model,
        messages: [
          { role: 'system', content: SYSTEM_PREAMBLE },
          { role: 'user', content: prompt },
        ],
        temperature,
        onProgress: onOutput,
        maxTokens,
        signal,
      });
    },

    buildPrompt(opts: ImplementerOptions) {
      return formatTaskPrompt(opts.task, opts.context, opts.config.implementer.contextLength);
    },

    buildRetryPrompt(opts: RetryOptions) {
      return formatRetryPrompt(opts.task, opts.context, opts.error, opts.attempt, opts.config.implementer.contextLength);
    },

    retryTemperatureStep: 0.1,
  });
}
