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
} from '../runners/cli-tool-catalog.js';
import type { RunnerRole } from '../runners/seat-roles.js';
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
  it('leaves LM Studio context limits to local discovery', () => {
    const model = KNOWN_MODELS['lm-studio']?.find((entry) => entry.isDefault);
    expect(model?.contextLength).toBeUndefined();
    expect(model?.provenance).toContain('discovered');
    expect(model?.recommendation).toBe('compatible-only');
  });
});

describe('KNOWN_MODELS claude-code aliases', () => {
  const claudeCode = KNOWN_MODELS['claude-code'] ?? [];

  it('offers every documented Claude Code alias', () => {
    expect(claudeCode.map((model) => model.name)).toEqual([
      'default',
      'best',
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'opusplan',
      'sonnet[1m]',
      'opus[1m]',
    ]);
  });

  it('points each Claude Code alias at the anthropic catalog row it is enriched from', () => {
    expect(
      claudeCode.map(({ name, catalogProvider, catalogModelId, contextLength }) => ({
        name,
        catalogProvider,
        catalogModelId,
        contextLength,
      })),
    ).toEqual([
      {
        name: 'default',
        catalogProvider: 'anthropic',
        catalogModelId: 'claude-sonnet-5',
        contextLength: 1_000_000,
      },
      {
        name: 'best',
        catalogProvider: 'anthropic',
        catalogModelId: 'claude-opus-5',
        contextLength: 1_000_000,
      },
      {
        name: 'fable',
        catalogProvider: 'anthropic',
        catalogModelId: 'claude-fable-5',
        contextLength: 1_000_000,
      },
      {
        name: 'opus',
        catalogProvider: 'anthropic',
        catalogModelId: 'claude-opus-5',
        contextLength: 1_000_000,
      },
      {
        name: 'sonnet',
        catalogProvider: 'anthropic',
        catalogModelId: 'claude-sonnet-5',
        contextLength: 1_000_000,
      },
      {
        name: 'haiku',
        catalogProvider: 'anthropic',
        catalogModelId: 'claude-haiku-4-5',
        contextLength: 200_000,
      },
      {
        name: 'opusplan',
        catalogProvider: 'anthropic',
        catalogModelId: 'claude-opus-5',
        contextLength: 1_000_000,
      },
      {
        name: 'sonnet[1m]',
        catalogProvider: 'anthropic',
        catalogModelId: 'claude-sonnet-5',
        contextLength: 1_000_000,
      },
      {
        name: 'opus[1m]',
        catalogProvider: 'anthropic',
        catalogModelId: 'claude-opus-5',
        contextLength: 1_000_000,
      },
    ]);
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
        if (providerId === 'claude-code' && model.name === 'default') continue;
        expect(
          normalizeConfiguredModel(model.name, providerId),
          `${providerId}/${model.name}`,
        ).not.toBe(AUTOMATIC_MODEL);
      }
    }
  });

  it("routes Claude Code's documented default alias to automatic selection", () => {
    expect(normalizeConfiguredModel('default', 'claude-code')).toBe(AUTOMATIC_MODEL);
    expect(resolveCliModel('default', 'claude-code')).toBeUndefined();
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
      expect(descriptor.roles).toEqual(['implementer']);
      expect(ImplementerConfigSchema.safeParse(runner).success, providerId).toBe(true);
    },
  );
});
