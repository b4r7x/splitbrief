import type { Config } from '../../core/schemas/config.js';
import type { ApiImplementerConfig } from '../../core/schemas/runner/implementer.js';
import type {
  Implementer,
  ImplementerFactoryOptions,
  ImplementerOptions,
  InvokeOpts,
  RetryOptions,
} from './types.js';
import { createImplementerBase } from './pipeline/run.js';
import { formatTaskPrompt, formatRetryPrompt } from '../spec/prompts/task.js';
import { getProvider } from '../providers/registry.js';
import { createProviderAvailability } from '../providers/client/availability.js';
import { createClientFromProvider } from '../providers/client/connection.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { assertImplementerKind } from '../config-assertions.js';
import { providerError } from '../providers/errors.js';
import { dispatchStreamCompletion } from '../providers/dispatch-stream.js';
import { toStreamClient } from '../providers/openai-stream/client.js';
import type { StreamClient } from '../providers/openai-stream/request.js';
import { DEFAULT_IMPLEMENTER_TEMPERATURE } from '../../core/schemas/runner/fields.js';
import { apiInvocationEvidence } from '../runners/invocation-identity.js';
import { admitApiCall, apiBudgetError, type PreparedApiSeat } from '../providers/api/admission.js';
import { apiBuildTargets } from '../providers/api/budget.js';
import { currentCodeContextMode } from '../orchestrator/context-routing/headings.js';

// Constructs the provider and its availability helper inside a try so a
// construction failure — a missing env-referenced key — yields `undefined`
// (reported as unavailable) instead of throwing out of the factory. Shared by
// the unavailability-reason member.
function providerAvailability(
  impl: ApiImplementerConfig,
  signal: AbortSignal | undefined,
): ReturnType<typeof createProviderAvailability> | undefined {
  try {
    const provider = getProvider(impl.provider, {
      apiBase: impl.apiBase,
      apiKey: impl.apiKey,
    });
    return createProviderAvailability(provider, signal);
  } catch {
    return undefined;
  }
}

export function createApiImplementer(
  initialConfig: Config,
  options?: ImplementerFactoryOptions,
): Implementer {
  const impl = assertImplementerKind(initialConfig, 'api');
  const availability = providerAvailability(impl, options?.signal);
  // Taken once, when the seat is built. A config whose endpoint or model moved
  // afterwards no longer matches it, and the call refuses instead of silently
  // dispatching somewhere else.
  const prepared: PreparedApiSeat = Object.freeze({
    seat: 'implementer',
    provider: impl.provider,
    apiBase: impl.apiBase,
    overrides: Object.freeze({
      apiBase: impl.apiBase,
      ...(impl.apiKey !== undefined && { apiKey: impl.apiKey }),
    }),
    // An unresolvable model has no identity to prepare; `invoke` refuses with
    // `missingModel` before the admission ever compares this.
    selectionId: resolveAutoModel(impl.model, impl.provider) ?? '',
    ...(impl.contextLength !== undefined && { configuredContextLength: impl.contextLength }),
  });

  return createImplementerBase({
    extractsCode: true,
    backendKind: 'api',
    // Every API BUILD call asks for the bundle — one file or many, first
    // attempt, retry or continuation alike. The response text never picks it.
    outputContract: 'file-bundle-v1',
    publisher: options?.publisher,
    // API backends send the system preamble as a separate system message.
    prependSystemPreamble: false,

    buildPrompt: (opts: ImplementerOptions) =>
      formatTaskPrompt({
        task: opts.task,
        context: opts.context,
        languageContext: opts.languageContext,
        outputContract: 'file-bundle-v1',
        plan: opts.plan,
      }),
    buildRetryPrompt: (opts: RetryOptions) =>
      formatRetryPrompt({
        task: opts.task,
        context: opts.context,
        error: opts.error,
        attempt: opts.attempt,
        kind: opts.kind,
        languageContext: opts.languageContext,
        outputContract: 'file-bundle-v1',
        plan: opts.plan,
      }),

    async invoke(opts: InvokeOpts) {
      const { prompt, config, onOutput, signal, systemPreamble } = opts;
      const impl = assertImplementerKind(config, 'api');
      const temperature = opts.temperature ?? impl.temperature ?? DEFAULT_IMPLEMENTER_TEMPERATURE;

      const model = resolveAutoModel(impl.model, impl.provider);
      if (!model) throw providerError.missingModel('implementer');

      // The brief's own current code is the evidence the rewrite is judged
      // against. A formatter that cut it to fit would ask for a rewrite of code
      // the model never saw, so the call refuses instead.
      if (currentCodeContextMode(opts.task, prompt) === 'truncated')
        throw apiBudgetError.currentCodeTruncated('implementer', opts.task.suggestedFiles[0]);

      const provider = getProvider(impl.provider, {
        apiBase: impl.apiBase,
        apiKey: impl.apiKey,
      });
      // The seat's `timeout` is the one total deadline of this call, for the SDK
      // client and the stream alike. A seat without one has no deadline.
      const client: StreamClient = toStreamClient(
        createClientFromProvider(provider, { timeoutMs: impl.timeout }),
      );

      // The system preamble is a message of its own on this transport, so both
      // it and the prompt are measured exactly as they go on the wire.
      const messages = [
        { role: 'system' as const, content: systemPreamble },
        { role: 'user' as const, content: prompt },
      ];

      const admission = await admitApiCall({
        prepared,
        dispatch: { provider: impl.provider, apiBase: impl.apiBase, model },
        messages,
        buildTargets: apiBuildTargets(opts.task),
        requestOptions: { temperature },
        ...(signal !== undefined && { signal }),
      });
      if (admission.kind === 'refused') throw admission.error;

      const maxTokens = admission.measurement.maxTokens;

      return dispatchStreamCompletion({
        provider: impl.provider,
        client,
        apiKey: provider.apiKey(),
        apiBase: provider.baseURL,
        model,
        messages,
        temperature,
        ...(opts.images !== undefined && { images: [...opts.images] }),
        onProgress: onOutput,
        maxTokens,
        runtimeObservation: admission.context,
        signal,
        timeoutMs: impl.timeout,
        onCallEvent: opts.onCallEvent,
        callContext: opts.callContext,
        invocationEvidence: apiInvocationEvidence(provider),
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
