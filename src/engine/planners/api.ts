import type { Config } from '../../core/types/config-options.js';
import type { InvokeResult } from '../../core/types/runner.js';
import type { Planner, PriorMessage } from './types.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { getProvider } from '../providers/registry.js';
import { createClientFromProvider } from '../providers/client.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { streamApiCompletion, throwAutoModelError } from '../api-shared.js';
import { assertPlannerKind } from '../config-assertions.js';
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
): Promise<InvokeResult> {
  return streamApiCompletion({
    client,
    provider: planner.provider,
    apiBase: planner.apiBase,
    apiKey: planner.apiKey,
    model,
    messages: buildMessages(prompt, priorMessages),
    temperature: 0.3,
    onProgress: onOutput,
  });
}

export function createApiPlanner(config: Config): Planner {
  const plannerCfg = assertPlannerKind(config, 'api');
  const provider = plannerCfg.provider;
  const model = resolveAutoModel(plannerCfg.model, provider);
  if (!model) throwAutoModelError('planner');
  const resolved = getProvider(provider, {
    apiBase: plannerCfg.apiBase,
    apiKey: plannerCfg.apiKey,
  });

  const client = provider === 'anthropic' ? null : createClientFromProvider(resolved);

  const invoke = ({ prompt, callbacks, priorMessages }: {
    prompt: string;
    projectDir: string;
    callbacks: { onOutput: (text: string) => void };
    priorMessages?: PriorMessage[] | undefined;
  }) =>
    invokeApi(
      client,
      model,
      { provider, apiBase: resolved.baseURL, apiKey: resolved.apiKey() },
      prompt,
      callbacks.onOutput,
      priorMessages,
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

    capabilities: ONE_SHOT_API_CAPS,
  });
}
