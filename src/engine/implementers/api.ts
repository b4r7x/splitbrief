import type { Config } from '../../types.js';
import type { Implementer, ImplementerOptions, RetryOptions } from './types.js';
import type { InvokeOpts } from './base.js';
import { createImplementerBase } from './base.js';
import { createClient } from '../provider-clients/index.js';
import { formatTaskPrompt, formatRetryPrompt, SYSTEM_PREAMBLE } from '../spec/formatter.js';
import { estimateTokens } from '../spec/token-budget.js';
import { asStreamClient, streamCompletion } from '../streaming/openai-stream.js';

export function createApiImplementer(config: Config): Implementer {
  const client = asStreamClient(createClient(config));

  return createImplementerBase({
    extractsCode: true,

    async invoke(opts: InvokeOpts) {
      const { prompt, config: cfg, onOutput } = opts;
      const temperature = opts.temperature ?? cfg.implementer.temperature;

      const promptTokens = estimateTokens(SYSTEM_PREAMBLE) + estimateTokens(prompt);
      const maxTokens = Math.max(cfg.implementer.contextLength - promptTokens, 1024);

      const completion = await streamCompletion(
        client,
        cfg.implementer.model,
        [
          { role: 'system', content: SYSTEM_PREAMBLE },
          { role: 'user', content: prompt },
        ],
        { temperature, onProgress: onOutput, endpoint: { provider: cfg.implementer.tool, apiBase: cfg.implementer.apiBase }, maxTokens },
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
