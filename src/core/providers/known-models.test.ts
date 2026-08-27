import { describe, it, expect } from 'vitest';
import {
  KNOWN_MODELS,
  PENDING_EVALUATION_CANDIDATE_IDS,
  type ModelRecommendation,
} from './known-models.js';
import {
  ADMITTED_API_PROVIDER_IDS,
  API_PROVIDER_CATALOG,
  KNOWN_API_PROVIDER_IDS,
} from './api-provider-catalog.js';
import { AUTOMATIC_MODEL, normalizeConfiguredModel, resolveCliModel } from './automatic-model.js';
import { resolveDefaultApiBase } from './catalog.js';
import {
  CLI_TOOL_IDS,
  cliModelPolicyViolations,
  getCliModelPolicy,
  type RunnerRole,
} from '../runners/cli-tool-catalog.js';
import { ImplementerConfigSchema } from '../schemas/implementer-config.js';
import { PlannerConfigSchema } from '../schemas/planner-config.js';
import { resolveAndSort } from '../../features/runners/model-catalog/catalog.js';

const RUNNER_ROLES = ['planner', 'implementer'] as const satisfies readonly RunnerRole[];

const OMITTED_REQ_051_060_PROVIDER_KEYS = [
  'mistral',
  'gemini',
  'cerebras',
  'zai',
  'mimo',
  'mimo-token-plan',
  'minimax',
  'minimax-token-plan',
  'moonshot',
  'dashscope',
  'llama-cpp',
] as const;

const RETIRED_DASHSCOPE_CODER_MODELS = ['qwen3-coder-next', 'qwen3-coder-plus'] as const;

function collectModelsByRecommendation(recommendation: ModelRecommendation) {
  return Object.entries(KNOWN_MODELS).flatMap(([provider, models]) =>
    (models ?? [])
      .filter((model) => model.recommendation === recommendation)
      .map((model) => ({ provider, model: model.name })),
  );
}

describe('KNOWN_MODELS DeepSeek V4 defaults', () => {
  const deepseek = KNOWN_MODELS.deepseek ?? [];
  const flash = deepseek.find((m) => m.name === 'deepseek-v4-flash');
  const pro = deepseek.find((m) => m.name === 'deepseek-v4-pro');

  it('defaults to V4 Flash and offers V4 Pro', () => {
    expect(flash?.isDefault).toBe(true);
    expect(pro?.isDefault).toBeUndefined();
    expect(deepseek.map((model) => model.name)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
  });

  it('records the current context and output ceilings for both V4 models', () => {
    expect(flash).toMatchObject({ contextLength: 1_000_000, maxOutputTokens: 384_000 });
    expect(pro).toMatchObject({ contextLength: 1_000_000, maxOutputTokens: 384_000 });
  });

  it('uses model-specific V4 pricing metadata', () => {
    expect(flash).toMatchObject({ pricingInput: 0.14, pricingOutput: 0.28 });
    expect(pro).toMatchObject({ pricingInput: 0.435, pricingOutput: 0.87 });
  });

  it('does not expose retired aliases as selectable defaults', () => {
    expect(deepseek.some((model) => model.name === 'deepseek-chat')).toBe(false);
    expect(deepseek.some((model) => model.name === 'deepseek-reasoner')).toBe(false);
  });

  it('keeps repaired DeepSeek models compatible-only after T-081', () => {
    expect(flash?.recommendation).toBe('compatible-only');
    expect(pro?.recommendation).toBe('compatible-only');
  });
});

describe('KNOWN_MODELS ollama entries', () => {
  const ollama = KNOWN_MODELS.ollama ?? [];
  const defaultModel = ollama.find((model) => model.isDefault);

  it('keeps the local fallback while leaving its context limit to discovery', () => {
    expect(defaultModel?.name).toBe('qwen3-coder:30b');
    expect(defaultModel?.contextLength).toBeUndefined();
    expect(defaultModel?.provenance).toContain('discovered');
    expect(defaultModel?.provenance).toContain('2026-07');
  });

  it('marks the default Ollama model compatible-only after T-080 quality failure', () => {
    expect(defaultModel?.recommendation).toBe('compatible-only');
  });
});

describe('KNOWN_MODELS cheap and local provider metadata', () => {
  it('marks OpenRouter free as an opportunistic non-default', () => {
    const free = KNOWN_MODELS.openrouter?.find((model) => model.name === 'openrouter/free');
    expect(free).toMatchObject({ isFree: true });
    expect(free?.isDefault).toBeUndefined();
    expect(free?.provenance).toContain('opportunistic');
    expect(free?.recommendation).toBe('compatible-only');
  });

  it('uses the Groq GPT OSS default and its output ceiling', () => {
    const model = KNOWN_MODELS.groq?.find((entry) => entry.isDefault);
    expect(model).toMatchObject({
      name: 'openai/gpt-oss-120b',
      contextLength: 131_072,
      maxOutputTokens: 65_536,
      recommendation: 'compatible-only',
    });
  });

  it('leaves LM Studio context limits to local discovery', () => {
    const model = KNOWN_MODELS['lm-studio']?.find((entry) => entry.isDefault);
    expect(model?.contextLength).toBeUndefined();
    expect(model?.provenance).toContain('discovered');
    expect(model?.recommendation).toBe('compatible-only');
  });
});

describe('KNOWN_MODELS recommendation metadata', () => {
  it('resolves every pending-evaluation candidate to a bundled row', () => {
    for (const candidate of PENDING_EVALUATION_CANDIDATE_IDS) {
      const model = (KNOWN_MODELS[candidate.provider] ?? []).find(
        (entry) => entry.name === candidate.model,
      );
      expect(model, `${candidate.provider}/${candidate.model}`).toBeDefined();
    }
  });

  it('freezes the exact pending-candidate provider/model identities', () => {
    expect(PENDING_EVALUATION_CANDIDATE_IDS).toEqual([
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
      { provider: 'groq', model: 'openai/gpt-oss-120b' },
      { provider: 'ollama', model: 'qwen3-coder:30b' },
      { provider: 'lm-studio', model: 'qwen2.5-coder-7b' },
    ]);
  });

  it('promotes no model to recommended without recorded T-080 evaluation metrics', () => {
    expect(collectModelsByRecommendation('recommended')).toEqual([]);
    for (const candidate of PENDING_EVALUATION_CANDIDATE_IDS) {
      const model = (KNOWN_MODELS[candidate.provider] ?? []).find(
        (entry) => entry.name === candidate.model,
      );
      expect(model?.recommendation, `${candidate.provider}/${candidate.model}`).toBe(
        'compatible-only',
      );
    }
  });

  it('records a provenance note on every bundled model row', () => {
    for (const [provider, models] of Object.entries(KNOWN_MODELS)) {
      for (const model of models ?? []) {
        expect(model.provenance, `${provider}/${model.name}`).toBeTruthy();
      }
    }
  });

  it('keeps every bundled catalog id non-empty and provenance off 2026-04', () => {
    for (const [provider, models] of Object.entries(KNOWN_MODELS)) {
      for (const model of models ?? []) {
        expect(model.catalogModelId ?? model.name, `${provider}/${model.name}`).toBeTruthy();
        expect(model.provenance, `${provider}/${model.name}`).not.toContain('2026-04');
      }
    }
  });

  it('omits REQ-051-060 provider keys when those descriptors were not admitted', () => {
    for (const key of OMITTED_REQ_051_060_PROVIDER_KEYS) {
      expect(KNOWN_MODELS).not.toHaveProperty(key);
    }
  });

  it('gives every admitted API provider exactly one default model', () => {
    for (const providerId of KNOWN_API_PROVIDER_IDS) {
      const defaults = (KNOWN_MODELS[providerId] ?? []).filter((model) => model.isDefault);
      expect(defaults).toHaveLength(1);
    }
  });

  it('keeps the direct Ollama Cloud fallback to one current coding model', () => {
    const defaults = (KNOWN_MODELS['ollama-cloud'] ?? []).filter((model) => model.isDefault);

    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({
      name: 'kimi-k2.7-code',
      recommendation: 'compatible-only',
      provenance: expect.stringContaining('direct /api/tags fallback (2026-08-01)'),
    });
  });

  it('does not expose retirement-date DashScope Coder models as selectable defaults', () => {
    const allNames = Object.values(KNOWN_MODELS).flatMap((models) =>
      (models ?? []).map((model) => model.name),
    );
    for (const retired of RETIRED_DASHSCOPE_CODER_MODELS) {
      expect(allNames).not.toContain(retired);
    }
  });
});

describe('automatic-selection sentinel coherence', () => {
  it('ships no catalog row that normalizes to the automatic sentinel', () => {
    for (const [providerId, models] of Object.entries(KNOWN_MODELS)) {
      for (const model of models ?? []) {
        expect(
          normalizeConfiguredModel(model.name, providerId),
          `${providerId}/${model.name}`,
        ).not.toBe(AUTOMATIC_MODEL);
      }
    }
  });

  it.each([...CLI_TOOL_IDS])('offers %s only models both role schemas accept', (tool) => {
    const offered = new Set([
      AUTOMATIC_MODEL,
      ...resolveAndSort(tool, 'planner').map(({ id }) => id),
      ...resolveAndSort(tool, 'implementer').map(({ id }) => id),
    ]);

    for (const model of offered) {
      const runner = { kind: 'cli', tool, model };
      expect(PlannerConfigSchema.safeParse(runner).success, `planner ${tool}/${model}`).toBe(true);
      expect(
        ImplementerConfigSchema.safeParse(runner).success,
        `implementer ${tool}/${model}`,
      ).toBe(true);
    }
  });

  it.each([...CLI_TOOL_IDS])('lets %s omit the model its sentinel resolves away to', (tool) => {
    expect(resolveCliModel(AUTOMATIC_MODEL, tool)).toBeUndefined();
    for (const role of RUNNER_ROLES) {
      expect(
        cliModelPolicyViolations(getCliModelPolicy(tool, role), {}),
        `${tool}/${role}`,
      ).toEqual([]);
    }
  });

  it.each([...ADMITTED_API_PROVIDER_IDS])(
    'ships a default model %s can be configured with',
    (providerId) => {
      const descriptor = API_PROVIDER_CATALOG[providerId];
      const defaultModel = (KNOWN_MODELS[providerId] ?? []).find(({ isDefault }) => isDefault);
      expect(defaultModel?.name, providerId).toBeTypeOf('string');

      const runner = {
        kind: 'api',
        provider: descriptor.id,
        service: descriptor.service,
        offering: descriptor.offering,
        apiBase: resolveDefaultApiBase(providerId),
        model: defaultModel?.name,
      };
      for (const role of descriptor.roles) {
        const schema = role === 'planner' ? PlannerConfigSchema : ImplementerConfigSchema;
        expect(schema.safeParse(runner).success, `${role} ${providerId}`).toBe(true);
      }
    },
  );
});
