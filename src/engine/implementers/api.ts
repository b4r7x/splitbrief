import type { Config } from '../../core/schemas/config.js';
import type { ApiImplementerConfig } from '../../core/schemas/implementer-config.js';
import type { Implementer, ImplementerFactoryOptions } from './types.js';
import type { InvokeOpts } from './utils.js';
import { createImplementerBase } from './base.js';
import { createClient } from '../providers/registry.js';
import { estimateTokens } from '../spec/token-budget.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { PROVIDER_CATALOG } from '../../core/providers/catalog.js';
import { isProviderId } from '../../core/schemas/enums.js';
import { assertImplementerKind } from './utils.js';
import { providerError } from '../providers/errors.js';
import { dispatchStreamCompletion } from '../providers/dispatch-stream.js';
import type { StreamClient } from '../providers/openai-stream.js';

function asApiConfig(config: Config): ApiImplementerConfig {
  return assertImplementerKind(config, 'api');
}

export function createApiImplementer(initialConfig: Config, options?: ImplementerFactoryOptions): Implementer {
  asApiConfig(initialConfig);

  return createImplementerBase({
    extractsCode: true,
    publisher: options?.publisher,
    // API backends send the system preamble as a separate system message.
    prependSystemPreamble: false,

    async invoke(opts: InvokeOpts) {
      const { prompt, config, onOutput, signal, systemPreamble } = opts;
      const impl = asApiConfig(config);
      const temperature = opts.temperature ?? impl.temperature ?? 0.7;
      const contextLength = impl.contextLength ?? 8192;

      const promptTokens = estimateTokens(systemPreamble) + estimateTokens(prompt);
      const available = contextLength - promptTokens;
      const maxTokens = Math.min(Math.max(available, 1024), contextLength);

      const model = resolveAutoModel(impl.model, impl.provider);
      if (!model) throw providerError.missingModel('implementer');

      const client = impl.provider === 'anthropic' ? null : createClient(config);

      const providerEnvKey = isProviderId(impl.provider) ? PROVIDER_CATALOG[impl.provider]?.apiKeyEnv : undefined;
      const resolvedApiKey = impl.apiKey ?? (providerEnvKey ? process.env[providerEnvKey] : undefined) ?? '';

      const messages = [
        { role: 'system' as const, content: systemPreamble },
        { role: 'user' as const, content: prompt },
      ];

      return dispatchStreamCompletion({
        provider: impl.provider,
        client: client as StreamClient | null,
        apiKey: resolvedApiKey,
        apiBase: impl.apiBase ?? '',
        model,
        messages,
        temperature,
        onProgress: onOutput,
        maxTokens,
        signal,
      });
    },

    retryTemperatureStep: 0.1,
  });
}
