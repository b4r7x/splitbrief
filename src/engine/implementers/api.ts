import type { Config } from '../../core/schemas/config.js';
import type { Implementer, ImplementerFactoryOptions, InvokeOpts } from './types.js';
import { createImplementerBase } from './base.js';
import { getProvider } from '../providers/registry.js';
import { createClientFromProvider } from '../providers/client.js';
import { estimateTokens } from '../../core/tokens/estimate.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { assertImplementerKind } from '../config-assertions.js';
import { providerError } from '../providers/errors.js';
import { dispatchStreamCompletion } from '../providers/dispatch-stream.js';
import { toStreamClient, type StreamClient } from '../providers/openai-stream.js';

export function createApiImplementer(
  initialConfig: Config,
  options?: ImplementerFactoryOptions,
): Implementer {
  assertImplementerKind(initialConfig, 'api');

  return createImplementerBase({
    extractsCode: true,
    publisher: options?.publisher,
    // API backends send the system preamble as a separate system message.
    prependSystemPreamble: false,

    async invoke(opts: InvokeOpts) {
      const { prompt, config, onOutput, signal, systemPreamble } = opts;
      const impl = assertImplementerKind(config, 'api');
      const temperature = opts.temperature ?? impl.temperature ?? 0.7;
      const contextLength = impl.contextLength ?? 8192;

      const promptTokens = estimateTokens(systemPreamble) + estimateTokens(prompt);
      const available = contextLength - promptTokens;
      const maxTokens = Math.min(Math.max(available, 1024), contextLength);

      const model = resolveAutoModel(impl.model, impl.provider);
      if (!model) throw providerError.missingModel('implementer');

      const provider = getProvider(impl.provider, {
        apiBase: impl.apiBase,
        apiKey: impl.apiKey,
      });
      const client: StreamClient | null =
        impl.provider === 'anthropic' ? null : toStreamClient(createClientFromProvider(provider));

      const messages = [
        { role: 'system' as const, content: systemPreamble },
        { role: 'user' as const, content: prompt },
      ];

      return dispatchStreamCompletion({
        provider: impl.provider,
        client,
        apiKey: provider.apiKey(),
        apiBase: provider.baseURL,
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
