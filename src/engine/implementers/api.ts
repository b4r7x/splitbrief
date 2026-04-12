import type { Config, ApiImplementerConfig } from '../../types.js';
import type { Implementer, ImplementerOptions, RetryOptions } from './types.js';
import type { InvokeOpts } from './utils.js';
import { createImplementerBase } from './base.js';
import { createClient } from '../provider-clients/index.js';
import { formatTaskPrompt, formatRetryPrompt, SYSTEM_PREAMBLE } from '../spec/formatter.js';
import { estimateTokens } from '../spec/token-budget.js';
import { asStreamClient, streamCompletion } from '../streaming/openai-stream.js';
import { resolveAutoModel } from '../../core/providers/models.js';

function asApiConfig(config: Config): ApiImplementerConfig {
  if (config.implementer.kind !== 'api') throw new Error('Expected api implementer config');
  return config.implementer;
}

export function createApiImplementer(initialConfig: Config): Implementer {
  const client = asStreamClient(createClient(initialConfig));

  return createImplementerBase({
    extractsCode: true,
    // API backends send SYSTEM_PREAMBLE as a separate system message
    prependSystemPreamble: false,

    async invoke(opts: InvokeOpts) {
      const { prompt, config, onOutput } = opts;
      const impl = asApiConfig(config);
      const temperature = opts.temperature ?? impl.temperature ?? 0.7;
      const contextLength = impl.contextLength ?? 8192;

      const promptTokens = estimateTokens(SYSTEM_PREAMBLE) + estimateTokens(prompt);
      const maxTokens = Math.max(contextLength - promptTokens, 1024);

      const model = resolveAutoModel(impl.model);
      if (!model) throw new Error(`API implementer requires an explicit model name — 'auto' is not supported for API backends. Set implementer.model in your config.`);

      const completion = await streamCompletion(
        client,
        model,
        [
          { role: 'system', content: SYSTEM_PREAMBLE },
          { role: 'user', content: prompt },
        ],
        { temperature, onProgress: onOutput, endpoint: { provider: impl.provider, apiBase: impl.apiBase }, maxTokens },
      );

      return { text: completion.text, usage: completion.usage };
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
