import type { Config, InvokeResult } from '../../types.js';
import type { Planner } from './types.js';
import { createPlannerBase } from './base.js';
import { getProvider } from '../provider-clients/registry.js';
import { createClientFromProvider } from '../provider-clients/client.js';
import { asStreamClient, streamCompletion } from '../streaming/openai-stream.js';
import { resolveAutoModel } from '../../core/providers/models.js';
import type OpenAI from 'openai';

async function invokeApi(
  client: OpenAI,
  model: string,
  planner: { provider: string; apiBase?: string | undefined },
  prompt: string,
  onOutput: (text: string) => void,
): Promise<InvokeResult> {
  const result = await streamCompletion(asStreamClient(client), model, [
    { role: 'user', content: prompt },
  ], {
    temperature: 0.3,
    onProgress: onOutput,
    endpoint: { provider: planner.provider, apiBase: planner.apiBase },
  });

  return {
    text: result.text,
    usage: result.usage,
  };
}

export function createApiPlanner(config: Config): Planner {
  if (config.planner.kind !== 'api') {
    throw new Error(`createApiPlanner requires planner.kind = 'api' (got ${config.planner.kind})`);
  }
  const plannerCfg = config.planner;
  const provider = plannerCfg.provider;
  const model = resolveAutoModel(plannerCfg.model);
  if (!model) throw new Error(`API planner requires an explicit model name — 'auto' is not supported for API backends. Set planner.model in your config.`);
  const resolved = getProvider(provider, {
    apiBase: plannerCfg.apiBase,
    apiKey: plannerCfg.apiKey,
  });

  const client = createClientFromProvider(resolved);

  const invoke = ({ prompt, callbacks }: { prompt: string; projectDir: string; callbacks: { onOutput: (text: string) => void } }) =>
    invokeApi(client, model, { provider, apiBase: plannerCfg.apiBase }, prompt, callbacks.onOutput);

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,

    async isAvailable() {
      try {
        await client.models.list();
        return true;
      } catch { /* API unreachable — treat as unavailable */
        return false;
      }
    },

    async getVersion() {
      return model;
    },
  });
}
