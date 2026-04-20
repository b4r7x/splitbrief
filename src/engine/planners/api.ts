import type { Config } from '../../core/schemas/config.js';
import type { InvokeResult } from '../runners/types.js';
import type { Planner, PriorMessage } from './types.js';
import type { EffortLevel, ProviderId } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { getProvider } from '../providers/registry.js';
import { createClientFromProvider } from '../providers/client.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { streamCompletion, type StreamClient } from '../providers/openai-stream.js';
import { streamAnthropicCompletion } from '../providers/anthropic/stream.js';
import { providerError } from '../providers/errors.js';
import { assertPlannerKind } from '../config-assertions.js';
import { isProviderId } from '../../core/schemas/enums.js';
import { modelSupportsEffort, modelSupportsImages } from '../providers/capability-inference.js';
import type OpenAI from 'openai';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

function buildMessages(prompt: string, priorMessages?: PriorMessage[] | undefined): ChatMessage[] {
  const history: ChatMessage[] = (priorMessages ?? []).map(m => ({ role: m.role, content: m.content }));
  history.push({ role: 'user', content: prompt });
  return history;
}

async function invokeApi(
  client: OpenAI | null,
  model: string,
  planner: { provider: string; apiBase?: string | undefined; apiKey: string },
  prompt: string,
  onOutput: (text: string) => void,
  priorMessages?: PriorMessage[] | undefined,
  effort?: EffortLevel | undefined,
  images?: Attachment[] | undefined,
): Promise<InvokeResult> {
  const messages = buildMessages(prompt, priorMessages);

  if (planner.provider === 'anthropic') {
    return streamAnthropicCompletion({
      apiKey: planner.apiKey,
      apiBase: planner.apiBase ?? '',
      model,
      messages,
      temperature: 0.3,
      onProgress: onOutput,
      ...(effort !== undefined && { effort }),
      ...(images && images.length > 0 ? { images } : {}),
    });
  }

  if (!client) throw providerError.expectedOpenAIClient(planner.provider);

  return streamCompletion(client as StreamClient, model, messages, {
    temperature: 0.3,
    onProgress: onOutput,
    endpoint: { provider: planner.provider, apiBase: planner.apiBase },
    ...(effort !== undefined && { effort }),
    ...(images && images.length > 0 ? { images } : {}),
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

  const client = provider === 'anthropic' ? null : createClientFromProvider(resolved);
  const effort = plannerCfg.effort;
  const providerId: ProviderId | null = isProviderId(provider) ? provider : null;
  const supportsEffort = providerId !== null && modelSupportsEffort(providerId, model);
  const supportsImages = providerId !== null && modelSupportsImages(providerId, model);

  const invoke = ({ prompt, callbacks, priorMessages, images }: {
    prompt: string;
    projectDir: string;
    callbacks: { onOutput: (text: string) => void };
    priorMessages?: PriorMessage[] | undefined;
    images?: Attachment[] | undefined;
  }) =>
    invokeApi(
      client,
      model,
      { provider, apiBase: resolved.baseURL, apiKey: resolved.apiKey() },
      prompt,
      callbacks.onOutput,
      priorMessages,
      supportsEffort ? effort : undefined,
      supportsImages ? images : undefined,
    );

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    consumesPriorMessages: true,

    async isAvailable() {
      try {
        return (await resolved.listModels()).length > 0;
      } catch { /* API unreachable — treat as unavailable */
        return false;
      }
    },

    async getVersion() {
      return model;
    },

    capabilities: { ...ONE_SHOT_API_CAPS, supportsEffort, supportsImages },
  });
}
