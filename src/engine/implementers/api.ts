import type { Config } from '../../core/schemas/config.js';
import type { ApiImplementerConfig } from '../../core/schemas/implementer-config.js';
import type {
  Implementer,
  ImplementerFactoryOptions,
  ImplementerOptions,
  InvokeOpts,
  RetryOptions,
} from './types.js';
import { createImplementerBase } from './pipeline/run.js';
import { formatTaskPrompt, formatRetryPrompt } from '../spec/prompt-formatter.js';
import { getProvider } from '../providers/registry.js';
import { createProviderAvailability } from '../providers/client/availability.js';
import { createClientFromProvider } from '../providers/client/connection.js';
import { estimateTokens } from '../../core/tokens/estimate.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { assertImplementerKind } from '../config-assertions.js';
import { providerError } from '../providers/errors.js';
import { dispatchStreamCompletion } from '../providers/dispatch-stream.js';
import { toStreamClient } from '../providers/openai-stream/client.js';
import type { StreamClient } from '../providers/openai-stream/request.js';
import { clampToMaxOutput } from '../providers/capability-inference.js';
import { DEFAULT_UNKNOWN_CONTEXT_LENGTH } from '../../core/tokens/context-length.js';
import { DEFAULT_IMPLEMENTER_TEMPERATURE } from '../../core/schemas/runner-fields.js';
import { composeAbortSignal } from '../../utils/abort.js';

// Constructs the provider and its availability helper inside a try so a
// construction failure — a missing env-referenced key — yields `undefined`
// (reported as unavailable) instead of throwing out of the factory. Shared by
// the unavailability-reason member.
function providerAvailability(
  impl: ApiImplementerConfig,
): ReturnType<typeof createProviderAvailability> | undefined {
  try {
    const provider = getProvider(impl.provider, {
      apiBase: impl.apiBase,
      apiKey: impl.apiKey,
    });
    return createProviderAvailability(provider);
  } catch {
    return undefined;
  }
}

export function createApiImplementer(
  initialConfig: Config,
  options?: ImplementerFactoryOptions,
): Implementer {
  const impl = assertImplementerKind(initialConfig, 'api');
  const availability = providerAvailability(impl);

  return createImplementerBase({
    extractsCode: true,
    backendKind: 'api',
    publisher: options?.publisher,
    // API backends send the system preamble as a separate system message.
    prependSystemPreamble: false,

    // An omitted contextLength resolves to the same default the request builder
    // uses (api.ts invoke), so the prompt is budgeted against the window the
    // request will actually enforce instead of being inserted unbudgeted.
    buildPrompt: (opts: ImplementerOptions) =>
      formatTaskPrompt({
        task: opts.task,
        context: opts.context,
        contextLength: opts.config.implementer.contextLength ?? DEFAULT_UNKNOWN_CONTEXT_LENGTH,
        languageContext: opts.languageContext,
      }),
    buildRetryPrompt: (opts: RetryOptions) =>
      formatRetryPrompt({
        task: opts.task,
        context: opts.context,
        error: opts.error,
        attempt: opts.attempt,
        contextLength: opts.config.implementer.contextLength ?? DEFAULT_UNKNOWN_CONTEXT_LENGTH,
        languageContext: opts.languageContext,
      }),

    async invoke(opts: InvokeOpts) {
      const { prompt, config, onOutput, signal, systemPreamble } = opts;
      const impl = assertImplementerKind(config, 'api');
      const temperature = opts.temperature ?? impl.temperature ?? DEFAULT_IMPLEMENTER_TEMPERATURE;
      const contextLength = impl.contextLength ?? DEFAULT_UNKNOWN_CONTEXT_LENGTH;
      const effectiveSignal = composeAbortSignal(signal, impl.timeout);

      const promptTokens = estimateTokens(systemPreamble) + estimateTokens(prompt);
      const available = contextLength - promptTokens;
      if (available <= 0) throw providerError.promptExceedsContext(promptTokens, contextLength);
      // Clamp to the model's max-output cap: the context window is not the output
      // limit, and conflating them sends an over-large max_tokens that 400s.
      const maxTokens = clampToMaxOutput(available);

      const model = resolveAutoModel(impl.model, impl.provider);
      if (!model) throw providerError.missingModel('implementer');

      const provider = getProvider(impl.provider, {
        apiBase: impl.apiBase,
        apiKey: impl.apiKey,
      });
      const client: StreamClient = toStreamClient(createClientFromProvider(provider));

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
        signal: effectiveSignal,
        onCallEvent: opts.onCallEvent,
        callContext: opts.callContext,
      });
    },

    retryTemperatureStep: 0.1,
    // Each availability gate re-probes the model list, so a verdict is never
    // cached across tasks.
    async isAvailable() {
      return (await availability?.isAvailable()) ?? false;
    },
    unavailabilityReason: () => availability?.unavailabilityReason(),
  });
}
