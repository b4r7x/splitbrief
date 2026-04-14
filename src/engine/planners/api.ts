import type { Config, InvokeResult } from '../../types.js';
import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import { getProvider } from '../providers/registry.js';
import { createClientFromProvider } from '../providers/client.js';
import { resolveAutoModel } from '../../core/providers.js';
import { streamApiCompletion, throwAutoModelError } from '../api-shared.js';
import { assertPlannerKind } from './utils.js';
import type OpenAI from 'openai';

async function invokeApi(
  client: OpenAI | null,
  model: string,
  planner: { provider: string; apiBase?: string | undefined; apiKey: string },
  prompt: string,
  onOutput: (text: string) => void,
): Promise<InvokeResult> {
  return streamApiCompletion({
    client,
    provider: planner.provider,
    apiBase: planner.apiBase,
    apiKey: planner.apiKey,
    model,
    messages: [{ role: 'user', content: prompt }],
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

  const invoke = ({ prompt, callbacks }: { prompt: string; projectDir: string; callbacks: { onOutput: (text: string) => void } }) =>
    invokeApi(
      client,
      model,
      { provider, apiBase: resolved.baseURL, apiKey: resolved.apiKey() },
      prompt,
      callbacks.onOutput,
    );

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,

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
  });
}
