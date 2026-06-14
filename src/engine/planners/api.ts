import type { Config } from '../../core/schemas/config.js';
import type { InvokeResult } from '../runners/types.js';
import type { Planner, PriorMessage } from './types.js';
import type { EffortLevel, ProviderId } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { getProvider } from '../providers/registry.js';
import { createClientFromProvider, describeProviderUnavailability } from '../providers/client.js';
import { estimateTokens } from '../../core/tokens/estimate.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { providerError } from '../providers/errors.js';
import { assertPlannerKind } from '../config-assertions.js';
import { isProviderId } from '../../core/schemas/enums.js';
import {
  modelSupportsEffort,
  modelSupportsImages,
  clampToMaxOutput,
} from '../providers/capability-inference.js';
import { dispatchStreamCompletion } from '../providers/dispatch-stream.js';
import { toStreamClient, type StreamClient } from '../providers/openai-stream.js';
import { composeAbortSignal } from '../../utils/abort.js';

const DEFAULT_CONTEXT_LENGTH = 8192;

type ChatMessage = { role: 'user' | 'assistant'; content: string };

function buildMessages(prompt: string, priorMessages?: PriorMessage[] | undefined): ChatMessage[] {
  const history: ChatMessage[] = (priorMessages ?? []).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  history.push({ role: 'user', content: prompt });
  return history;
}

async function invokeApi(opts: {
  client: StreamClient | null;
  model: string;
  contextLength: number;
  planner: {
    provider: string;
    apiBase?: string | undefined;
    apiKey: string;
    temperature?: number | undefined;
  };
  prompt: string;
  onOutput: (text: string) => void;
  priorMessages?: PriorMessage[] | undefined;
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
}): Promise<InvokeResult> {
  const messages = buildMessages(opts.prompt, opts.priorMessages);
  const promptTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const maxTokens = clampToMaxOutput(Math.max(opts.contextLength - promptTokens, 1024));
  return dispatchStreamCompletion({
    provider: opts.planner.provider,
    client: opts.client,
    apiKey: opts.planner.apiKey,
    apiBase: opts.planner.apiBase ?? '',
    model: opts.model,
    messages,
    temperature: opts.planner.temperature ?? 0.3,
    onProgress: opts.onOutput,
    maxTokens,
    effort: opts.effort,
    images: opts.images,
    signal: opts.signal,
  });
}

export function createApiPlanner(config: Config): Planner {
  const plannerCfg = assertPlannerKind(config, 'api');
  const provider = plannerCfg.provider;
  const model = resolveAutoModel(plannerCfg.model, provider);
  if (!model) throw providerError.missingModel('planner');
  const resolved = getProvider(provider, {
    apiBase: plannerCfg.apiBase,
    apiKey: plannerCfg.apiKey,
  });

  const client: StreamClient | null =
    provider === 'anthropic' ? null : toStreamClient(createClientFromProvider(resolved));
  const effort = plannerCfg.effort;
  const timeout = plannerCfg.timeout;
  const contextLength = plannerCfg.contextLength ?? DEFAULT_CONTEXT_LENGTH;
  const providerId: ProviderId | null = isProviderId(provider) ? provider : null;
  const supportsEffort = providerId !== null && modelSupportsEffort(providerId, model);
  const supportsImages = providerId !== null && modelSupportsImages(providerId, model);

  const invoke = ({
    prompt,
    callbacks,
    priorMessages,
    images,
    signal,
  }: {
    prompt: string;
    projectDir: string;
    callbacks: { onOutput: (text: string) => void };
    priorMessages?: PriorMessage[] | undefined;
    images?: Attachment[] | undefined;
    signal?: AbortSignal | undefined;
  }) => {
    const effectiveSignal = composeAbortSignal(signal, timeout);
    return invokeApi({
      client,
      model,
      contextLength,
      planner: {
        provider,
        apiBase: resolved.baseURL,
        apiKey: resolved.apiKey(),
        temperature: plannerCfg.temperature,
      },
      prompt,
      onOutput: callbacks.onOutput,
      priorMessages,
      effort: supportsEffort ? effort : undefined,
      images: supportsImages ? images : undefined,
      signal: effectiveSignal,
    });
  };

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    consumesPriorMessages: true,

    async isAvailable() {
      try {
        return (await resolved.listModels()).length > 0;
      } catch {
        return false;
      }
    },

    unavailabilityReason() {
      return describeProviderUnavailability({
        isLocal: resolved.isLocal,
        hasKey: resolved.apiKey().length > 0,
        lastError: resolved.getLastError?.(),
      });
    },

    async getVersion() {
      return model;
    },

    capabilities: { ...ONE_SHOT_API_CAPS, supportsEffort, supportsImages },
  });
}
