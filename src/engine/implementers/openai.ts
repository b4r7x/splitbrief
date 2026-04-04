import type { Config } from '../../types.js';
import type { ImplementerOptions, RetryOptions } from './base.js';
import type { ImplementerBackend } from './types.js';
import type { InvokeOpts } from './base.js';
import { createImplementerBase } from './base.js';
import { createClient } from '../providers.js';
import { formatTaskPrompt, formatRetryPrompt, SYSTEM_PREAMBLE } from '../spec/formatter.js';
import { estimateTokens } from '../spec/token-budget.js';
import { streamCompletion } from '../openai-stream.js';

export function createOpenAIImplementer(config: Config): ImplementerBackend {
  return createImplementerBase({
    name: 'openai',
    pricingKey: config.implementer.provider,
    extractsCode: true,

    async invoke(opts: InvokeOpts) {
      const { prompt, config: cfg, onProgress } = opts;
      const temperature = opts.temperature ?? cfg.implementer.temperature;

      const client = createClient(cfg);
      const promptTokens = estimateTokens(SYSTEM_PREAMBLE) + estimateTokens(prompt);
      const maxTokens = Math.max(cfg.implementer.contextLength - promptTokens, 1024);

      const completion = await streamCompletion(
        client,
        cfg.implementer.model,
        [
          { role: 'system', content: SYSTEM_PREAMBLE },
          { role: 'user', content: prompt },
        ],
        { temperature, onProgress, endpoint: { provider: cfg.implementer.provider, apiBase: cfg.implementer.apiBase }, maxTokens },
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

    async isAvailable() {
      return true;
    },
  });
}

