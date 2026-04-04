import type { Config } from '../../types.js';
import type { PlannerBackend } from './types.js';
import type { InvokeResult } from './base.js';
import { createPlannerBase } from './base.js';
import { getProvider } from '../providers/registry.js';
import { streamCompletion } from '../openai-stream.js';
import OpenAI from 'openai';

async function invokeApi(
  client: OpenAI,
  model: string,
  config: Config,
  prompt: string,
  onOutput: (text: string) => void,
): Promise<InvokeResult> {
  const result = await streamCompletion(client, model, [
    { role: 'user', content: prompt },
  ], {
    temperature: 0.3,
    onProgress: onOutput,
    endpoint: { provider: config.planner.provider || 'api', apiBase: config.planner.apiBase },
  });

  return {
    text: result.text,
    usage: result.usage ? {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    } : null,
  };
}

export function createApiPlanner(config: Config): PlannerBackend {
  if (!config.planner.provider) throw new Error('API planner requires planner.provider');
  const provider = config.planner.provider;
  const model = config.planner.model ?? 'default';
  const resolved = getProvider(provider, {
    apiBase: config.planner.apiBase,
    apiKey: config.planner.apiKey,
  });

  const client = new OpenAI({
    baseURL: resolved.baseURL,
    apiKey: resolved.apiKey(),
  });

  return createPlannerBase({
    name: `api:${provider}`,
    pricingKey: provider,

    async invokePlan(prompt, _projectDir, onOutput) {
      return invokeApi(client, model, config, prompt, onOutput);
    },

    async invokeEscalate(prompt, _projectDir, onOutput) {
      return invokeApi(client, model, config, prompt, onOutput);
    },

    async isAvailable() {
      try {
        await client.models.list();
        return true;
      } catch {
        return false;
      }
    },

    async getVersion() {
      return model;
    },
  });
}
