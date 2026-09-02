import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import { fromYaml } from '../../core/config/load/transform.js';
import { getProviderDisplayName } from '../../core/providers/catalog.js';
import { defaultCliAuthChannel } from '../../core/runners/cli-tool-catalog.js';
import { ConfigSchema } from '../../core/schemas/config.js';
import type { Config } from '../../core/schemas/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { realPickerOption } from '#testing/helpers/runner-picker.js';
import {
  commitCustomCommand,
  commitCustomModel,
  commitImplementerSelection,
  commitPlannerTierSelection,
  inheritsPlannerSeat,
  removeCustomModel,
} from './config-transforms.js';

function makeBaseConfig(): Config {
  return makeConfig({
    planner: {
      kind: 'shell',
      command: 'old-command',
    },
    implementer: {
      service: 'ollama',
      offering: 'local',
      model: 'llama3',
      contextLength: 8192,
      temperature: 0.3,
    },
    workflow: { persistTranscript: true },
  });
}

function makeConfigWithOptionalSections(): Config {
  return {
    ...makeBaseConfig(),
    codebase: {
      enabled: true,
      tokenBudget: 1234,
      cacheDir: '.splitbrief-cache',
      include: ['src/**'],
      exclude: ['dist/**'],
    },
    hooks: {
      builtin: { snapshots: false },
    },
    otel: {
      enabled: true,
      serviceName: 'splitbrief-test',
    },
    snapshots: {
      auto: {
        preTask: true,
        postTask: false,
        preFinalReview: true,
      },
    },
    palette: {
      customActions: [
        {
          id: 'refresh-docs',
          label: 'Refresh docs',
          description: 'Refresh documentation',
          command: '/refresh',
        },
      ],
    },
    approval: {
      enabled: true,
      headless: true,
      tiers: { read: 'auto', destructive: 'confirm' },
      feedRejectionsToPlanner: false,
    },
  };
}

function namedImplementerProfileConfig(): Config {
  return ConfigSchema.parse(
    fromYaml(
      YAML.parse(`
version: 3
planner:
  kind: cli
  tool: claude-code
implementer:
  kind: cli
  tool: codex
  model: legacy-model
implementer_profiles:
  default: active-cloud
  profiles:
    active-cloud:
      kind: api
      provider: lm-studio
      service: lm-studio
      offering: local
      api_base: http://localhost:1234/v1
      api_key: env:PATH
      model: existing-model
      custom_models:
        - existing-model
      label: Active cloud
      cost_tier: cheap
    dormant-local:
      kind: cli
      tool: codex
      model: dormant-model
validation:
  typecheck: true
  lint: true
  test: true
workflow:
  max_retries: 3
  persist_transcript: true
  compaction_format: auto
`),
    ),
  );
}

describe('commitCustomCommand', () => {
  it('preserves kind: shell for shell selection', () => {
    const config = makeBaseConfig();
    const updated = commitCustomCommand({
      config,
      role: 'planner',
      command: 'my-shell-tool --flag',
      kind: 'shell',
    });
    expect(updated.planner.kind).toBe('shell');
    if (updated.planner.kind === 'shell') {
      expect(updated.planner.command).toBe('my-shell-tool --flag');
    }
  });

  it('preserves kind: agent for agent selection', () => {
    const config = makeBaseConfig();
    const updated = commitCustomCommand({
      config,
      role: 'planner',
      command: 'my-agent-tool --flag',
      kind: 'agent',
    });
    expect(updated.planner.kind).toBe('agent');
    if (updated.planner.kind === 'agent') {
      expect(updated.planner.command).toBe('my-agent-tool --flag');
    }
  });

  it('writes a custom command onto the reviewer seat, not the planner', () => {
    const config = makeBaseConfig();
    const updated = commitCustomCommand({
      config,
      role: 'reviewer',
      command: 'my-review-tool --flag',
      kind: 'shell',
    });
    expect(updated.reviewer).toMatchObject({ kind: 'shell', command: 'my-review-tool --flag' });
    expect(updated.planner).toEqual(config.planner);
  });

  it('preserves implementer kind: shell for shell implementer selection', () => {
    const config: Config = {
      ...makeBaseConfig(),
      implementer: {
        kind: 'shell',
        command: 'old-impl',
        model: 'llama3',
      },
    };
    const updated = commitCustomCommand({
      config,
      role: 'implementer',
      command: 'new-impl-cmd',
      kind: 'shell',
    });
    expect(updated.implementer.kind).toBe('shell');
    if (updated.implementer.kind === 'shell') {
      expect(updated.implementer.command).toBe('new-impl-cmd');
    }
  });

  it('preserves implementer kind: agent for agent implementer selection', () => {
    const config: Config = {
      ...makeBaseConfig(),
      implementer: {
        kind: 'agent',
        command: 'old-impl',
        model: 'llama3',
      },
    };
    const updated = commitCustomCommand({
      config,
      role: 'implementer',
      command: 'new-agent-impl',
      kind: 'agent',
    });
    expect(updated.implementer.kind).toBe('agent');
    if (updated.implementer.kind === 'agent') {
      expect(updated.implementer.command).toBe('new-agent-impl');
    }
  });
});

describe('runner selection commits', () => {
  it('persists an automatic CLI selection as the explicit auto sentinel on the planner', () => {
    const config: Config = {
      ...makeBaseConfig(),
      planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
    };

    const { config: updated } = commitPlannerTierSelection({
      config,
      role: 'planner',
      selection: realPickerOption('planner', 'claude-code'),
      model: { id: 'auto' },
    });

    expect(updated.planner).toEqual({ kind: 'cli', tool: 'claude-code', model: 'auto' });
  });

  it('persists an automatic CLI selection verbatim into a named implementer profile only', () => {
    const config = namedImplementerProfileConfig();
    const before = config.implementerProfiles?.profiles;
    const siblings = Object.fromEntries(
      Object.entries(before ?? {}).filter(([name]) => name !== 'active-cloud'),
    );

    const { config: updated } = commitImplementerSelection({
      config,
      selection: realPickerOption('implementer', 'codex'),
      model: { id: 'AUTO' },
    });

    // Stored exactly as chosen — the picker's own Auto row carries the lower-case
    // id, and nothing rewrites a user's spelling behind their back.
    expect(updated.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      kind: 'cli',
      tool: 'codex',
      model: 'AUTO',
    });
    for (const [name, profile] of Object.entries(siblings)) {
      expect(updated.implementerProfiles?.profiles[name]).toEqual(profile);
    }
  });

  it('switches a named API profile to CLI without parsing the API profile as model-less', () => {
    const config = namedImplementerProfileConfig();
    const { config: updated } = commitImplementerSelection({
      config,
      selection: realPickerOption('implementer', 'codex'),
      model: null,
    });

    expect(updated.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      kind: 'cli',
      tool: 'codex',
    });
    expect(updated.implementerProfiles?.profiles['active-cloud']).not.toHaveProperty('model');
  });

  it('preserves an active API model when the API provider remains selected', () => {
    const config = namedImplementerProfileConfig();
    const { config: updated } = commitImplementerSelection({
      config,
      selection: realPickerOption('implementer', 'lm-studio'),
      model: null,
    });

    expect(updated.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      kind: 'api',
      provider: 'lm-studio',
      model: 'existing-model',
    });
  });

  it('preserves explicit model IDs when committing a CLI selection', () => {
    const { config: updated } = commitPlannerTierSelection({
      config: makeBaseConfig(),
      role: 'planner',
      selection: realPickerOption('planner', 'claude-code'),
      model: { id: 'sonnet' },
    });

    expect(updated.planner).toEqual({
      kind: 'cli',
      tool: 'claude-code',
      authChannel: defaultCliAuthChannel('claude-code').id,
      model: 'sonnet',
    });
  });

  it('drops source model metadata when switching without a destination model', () => {
    const config: Config = {
      ...makeBaseConfig(),
      implementer: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://api.example.com/v1',
        model: 'source-model',
        customModels: ['source-model', 'source-only-model'],
      },
    };

    const { config: updated } = commitImplementerSelection({
      config,
      selection: realPickerOption('implementer', 'codex'),
      model: null,
    });

    expect(updated.implementer).toEqual({ kind: 'cli', tool: 'codex' });
  });

  it('requires an explicit model when switching to a destination that needs one', () => {
    const config: Config = {
      ...makeBaseConfig(),
      implementer: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://api.example.com/v1',
        model: 'source-model',
        customModels: ['source-model', 'source-only-model'],
      },
    };

    expect(() =>
      commitImplementerSelection({
        config,
        selection: realPickerOption('implementer', 'ollama'),
        model: null,
      }),
    ).toThrow(/model/);
  });

  it('switches implementers from shell to api when selecting an API provider', () => {
    const config: Config = {
      ...makeBaseConfig(),
      implementer: { kind: 'shell', command: 'old-impl', model: 'llama3' },
    };
    const { config: updated } = commitImplementerSelection({
      config,
      selection: realPickerOption('implementer', 'lm-studio'),
      model: { id: 'qwen2.5-coder-7b' },
    });

    expect(updated.implementer.kind).toBe('api');
    if (updated.implementer.kind === 'api') {
      expect(updated.implementer.provider).toBe('lm-studio');
      expect(updated.implementer.apiBase).toBe('http://localhost:1234/v1');
    }
  });

  it('preserves optional top-level config sections when committing picker selections', () => {
    const config = makeConfigWithOptionalSections();
    const { config: updated } = commitPlannerTierSelection({
      config,
      role: 'planner',
      selection: realPickerOption('planner', 'codex'),
      model: { id: 'auto' },
    });

    expect(updated.codebase).toEqual(config.codebase);
    expect(updated.hooks).toEqual(config.hooks);
    expect(updated.otel).toEqual(config.otel);
    expect(updated.snapshots).toEqual(config.snapshots);
    expect(updated.palette).toEqual(config.palette);
    expect(updated.approval).toEqual(config.approval);
  });

  it('updates every picker field on the active named implementer profile', () => {
    const config = namedImplementerProfileConfig();
    const profiles = config.implementerProfiles;
    expect(profiles).toBeDefined();
    if (!profiles) return;
    const dormant = profiles.profiles['dormant-local'];

    const { config: selectedModel } = commitImplementerSelection({
      config,
      selection: realPickerOption('implementer', 'lm-studio'),
      model: { id: 'selected-model' },
    });
    const selectedApi = selectedModel.implementerProfiles?.profiles['active-cloud'];
    expect(selectedApi).toMatchObject({
      kind: 'api',
      provider: 'lm-studio',
      apiBase: 'http://localhost:1234/v1',
      apiKey: 'env:PATH',
      model: 'selected-model',
    });

    const { config: selectedTool } = commitImplementerSelection({
      config,
      selection: realPickerOption('implementer', 'codex'),
      model: { id: 'gpt-5.4-mini' },
    });
    expect(selectedTool.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      kind: 'cli',
      tool: 'codex',
      model: 'gpt-5.4-mini',
    });

    const customAdded = commitCustomModel({
      config,
      role: 'implementer',
      selection: realPickerOption('implementer', 'lm-studio'),
      modelName: 'custom-added',
      customModels: ['existing-model'],
    });
    expect(customAdded.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      model: 'custom-added',
      customModels: ['existing-model', 'custom-added'],
      apiBase: 'http://localhost:1234/v1',
      apiKey: 'env:PATH',
    });

    const customRemoved = removeCustomModel(customAdded, 'implementer', 'custom-added');
    expect(customRemoved.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      model: 'existing-model',
      customModels: ['existing-model'],
    });

    const customCommand = commitCustomCommand({
      config,
      role: 'implementer',
      command: 'local-implementer --stdio',
      kind: 'agent',
    });
    expect(customCommand.implementerProfiles?.profiles['active-cloud']).toEqual({
      kind: 'agent',
      command: 'local-implementer --stdio',
      model: 'existing-model',
      label: 'Active cloud',
      costTier: 'cheap',
    });

    for (const updated of [
      selectedModel,
      selectedTool,
      customAdded,
      customRemoved,
      customCommand,
    ]) {
      expect(updated.implementerProfiles?.profiles['dormant-local']).toEqual(dormant);
    }
  });
});

const OPENCODE_MODEL = 'openai/gpt-5.6';

describe('effort and variant follow the seat channel', () => {
  function opencodePlanner(): Config {
    return makeConfig({ planner: { kind: 'cli', tool: 'opencode', model: OPENCODE_MODEL } });
  }

  it.each([
    { seat: 'planner', tool: 'claude-code', modelId: 'auto', keepsEffort: true },
    { seat: 'planner', tool: 'codex', modelId: 'auto', keepsEffort: false },
    { seat: 'planner', tool: 'opencode', modelId: OPENCODE_MODEL, keepsEffort: false },
    { seat: 'implementer', tool: 'claude-code', modelId: 'auto', keepsEffort: true },
    { seat: 'implementer', tool: 'codex', modelId: 'auto', keepsEffort: false },
  ] as const)(
    'effort survives a $seat commit on $tool only when the tool channel is an effort flag',
    ({ seat, tool, modelId, keepsEffort }) => {
      const { config: updated, notice } =
        seat === 'planner'
          ? commitPlannerTierSelection({
              config: makeConfig({
                planner: { kind: 'cli', tool, model: modelId, effort: 'high' },
              }),
              role: 'planner',
              selection: realPickerOption('planner', tool),
              model: { id: modelId },
            })
          : commitImplementerSelection({
              config: makeConfig({
                implementer: { kind: 'cli', tool, model: modelId, effort: 'high' },
              }),
              selection: realPickerOption('implementer', tool),
              model: { id: modelId },
            });

      const committed = seat === 'planner' ? updated.planner : updated.implementer;
      expect(committed).toMatchObject({ kind: 'cli', tool });

      if (keepsEffort) {
        expect(committed).toMatchObject({ effort: 'high' });
        expect(notice).toBeUndefined();
        return;
      }
      expect(committed).not.toHaveProperty('effort');
      expect(notice).toContain(getProviderDisplayName(tool));
      expect(notice).toContain('high');
    },
  );

  it('saves a variant on an opencode seat', () => {
    const { config: updated, notice } = commitPlannerTierSelection({
      config: opencodePlanner(),
      role: 'planner',
      selection: realPickerOption('planner', 'opencode'),
      model: { id: OPENCODE_MODEL },
      variant: 'high',
    });

    expect(updated.planner).toMatchObject({
      kind: 'cli',
      tool: 'opencode',
      model: OPENCODE_MODEL,
      variant: 'high',
    });
    expect(notice).toBeUndefined();
  });

  it('clears a variant on a seat with no variant channel and says so', () => {
    const { config: updated, notice } = commitImplementerSelection({
      config: makeConfig({ implementer: { kind: 'cli', tool: 'claude-code', model: 'auto' } }),
      selection: realPickerOption('implementer', 'claude-code'),
      model: { id: 'auto' },
      variant: 'xhigh',
    });

    expect(updated.implementer).not.toHaveProperty('variant');
    expect(notice).toContain('xhigh');
    expect(notice).toContain(getProviderDisplayName('claude-code'));
  });

  it('reports both notices on one line when a seat change drops effort and variant together', () => {
    const config = makeConfig({
      planner: {
        kind: 'cli',
        tool: 'claude-code',
        model: 'auto',
        effort: 'high',
        variant: 'max',
      },
    });

    const { config: updated, notice } = commitPlannerTierSelection({
      config,
      role: 'planner',
      selection: realPickerOption('planner', 'codex'),
      model: { id: 'auto' },
    });

    expect(updated.planner).not.toHaveProperty('effort');
    expect(updated.planner).not.toHaveProperty('variant');
    expect(notice).toContain('Effort high');
    expect(notice).toContain('Variant max');
    expect(notice).not.toContain('\n');
  });

  it('round-trips a custom variant name the vocabulary does not know', () => {
    const { config: updated, notice } = commitPlannerTierSelection({
      config: opencodePlanner(),
      role: 'planner',
      selection: realPickerOption('planner', 'opencode'),
      model: { id: OPENCODE_MODEL },
      variant: 'my-house-preset',
    });

    expect(updated.planner).toMatchObject({ variant: 'my-house-preset' });
    expect(notice).toBeUndefined();
  });

  it('drops a carried variant the new model does not spell and says so', () => {
    const config = makeConfig({
      planner: {
        kind: 'cli',
        tool: 'opencode',
        model: 'anthropic/claude-opus-4-8',
        variant: 'max',
      },
    });

    const { config: updated, notice } = commitPlannerTierSelection({
      config,
      role: 'planner',
      selection: realPickerOption('planner', 'opencode'),
      model: { id: OPENCODE_MODEL },
    });

    expect(updated.planner).not.toHaveProperty('variant');
    expect(notice).toContain('Variant max');
    expect(notice).toContain(OPENCODE_MODEL);
  });

  it('carries a variant both models spell', () => {
    const config = makeConfig({
      planner: {
        kind: 'cli',
        tool: 'opencode',
        model: 'anthropic/claude-opus-4-8',
        variant: 'high',
      },
    });

    const { config: updated, notice } = commitPlannerTierSelection({
      config,
      role: 'planner',
      selection: realPickerOption('planner', 'opencode'),
      model: { id: OPENCODE_MODEL },
    });

    expect(updated.planner).toMatchObject({ model: OPENCODE_MODEL, variant: 'high' });
    expect(notice).toBeUndefined();
  });

  it('keeps a custom variant name when the model is unchanged', () => {
    const config = makeConfig({
      planner: {
        kind: 'cli',
        tool: 'opencode',
        model: OPENCODE_MODEL,
        variant: 'my-house-preset',
      },
    });

    const { config: updated, notice } = commitPlannerTierSelection({
      config,
      role: 'planner',
      selection: realPickerOption('planner', 'opencode'),
      model: { id: OPENCODE_MODEL },
    });

    expect(updated.planner).toMatchObject({ variant: 'my-house-preset' });
    expect(notice).toBeUndefined();
  });
});

describe('commitPlannerTierSelection for the reviewer seat', () => {
  it('writes the reviewer block and leaves the planner untouched', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } });
    const plannerBefore = JSON.stringify(config.planner);

    const { config: updated } = commitPlannerTierSelection({
      config,
      role: 'reviewer',
      selection: realPickerOption('planner', 'codex'),
      model: { id: 'auto' },
    });

    expect(updated.reviewer).toMatchObject({ kind: 'cli', tool: 'codex' });
    expect(JSON.stringify(updated.planner)).toBe(plannerBefore);
  });

  it('records an explicit reviewer block even when the choice matches the planner', () => {
    const config = makeConfig({ planner: { kind: 'cli', tool: 'claude-code', model: 'auto' } });

    const { config: updated } = commitPlannerTierSelection({
      config,
      role: 'reviewer',
      selection: realPickerOption('planner', 'claude-code'),
      model: { id: 'auto' },
    });

    expect(updated.reviewer).toMatchObject({ kind: 'cli', tool: 'claude-code' });
  });

  it('replaces an already configured reviewer without touching the planner', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'auto' },
      reviewer: { kind: 'cli', tool: 'codex', model: 'auto' },
    });
    const plannerBefore = JSON.stringify(config.planner);

    const { config: updated } = commitPlannerTierSelection({
      config,
      role: 'reviewer',
      selection: realPickerOption('planner', 'opencode'),
      model: { id: 'auto' },
    });

    expect(updated.reviewer).toMatchObject({ kind: 'cli', tool: 'opencode' });
    expect(JSON.stringify(updated.planner)).toBe(plannerBefore);
  });

  it('does not carry the planner inline API key onto a CLI reviewer', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://api.example.com/v1',
        apiKey: 'sk-planner-secret',
        model: 'custom-endpoint-model',
      },
    });

    const { config: updated } = commitPlannerTierSelection({
      config,
      role: 'reviewer',
      selection: realPickerOption('planner', 'codex'),
      model: { id: 'auto' },
    });

    expect(updated.reviewer).toMatchObject({ kind: 'cli', tool: 'codex' });
    expect(JSON.stringify(updated.reviewer)).not.toContain('sk-planner-secret');
    expect(updated.planner).toMatchObject({ apiKey: 'sk-planner-secret' });
  });

  it('seeds the reviewer with a custom model without touching the planner', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
    });
    const plannerBefore = JSON.stringify(config.planner);

    const updated = commitCustomModel({
      config,
      role: 'reviewer',
      selection: realPickerOption('planner', 'claude-code'),
      modelName: 'my-model',
      customModels: ['sonnet'],
    });

    expect(updated.reviewer).toMatchObject({ model: 'my-model' });
    expect(JSON.stringify(updated.planner)).toBe(plannerBefore);
  });
});

describe('removeCustomModel', () => {
  function makeConfigWithCustomModels(): Config {
    return {
      ...makeBaseConfig(),
      planner: {
        kind: 'cli' as const,
        tool: 'claude-code' as const,
        model: 'my-custom-planner',
        customModels: ['my-custom-planner', 'other-planner-model'],
      },
      implementer: {
        kind: 'api' as const,
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'my-custom-impl',
        contextLength: 8192,
        temperature: 0.3,
        customModels: ['my-custom-impl', 'other-impl-model'],
      },
    };
  }

  it('removes inactive planner custom models and clears model when deleting the active one', () => {
    const config = makeConfigWithCustomModels();
    const updatedInactive = removeCustomModel(config, 'planner', 'other-planner-model');
    expect(updatedInactive.planner.customModels).toEqual(['my-custom-planner']);

    const updatedActive = removeCustomModel(config, 'planner', 'my-custom-planner');
    expect(updatedActive.planner.customModels).toEqual(['other-planner-model']);
    expect(updatedActive.planner.model).toBeUndefined();
    expect('model' in updatedActive.planner).toBe(false);
  });

  it('reports that the reviewer inherits the planner seat until it has its own block', () => {
    const config = makeConfigWithCustomModels();
    expect(inheritsPlannerSeat(config, 'reviewer')).toBe(true);
    expect(inheritsPlannerSeat(config, 'planner')).toBe(false);
    expect(
      inheritsPlannerSeat(
        { ...config, reviewer: { kind: 'cli', tool: 'codex' } as const },
        'reviewer',
      ),
    ).toBe(false);
  });

  it('removes a custom model from the reviewer block without touching the planner', () => {
    const config: Config = {
      ...makeConfigWithCustomModels(),
      reviewer: { kind: 'cli', tool: 'codex', customModels: ['my-custom-reviewer'] },
    };
    const updated = removeCustomModel(config, 'reviewer', 'my-custom-reviewer');
    expect(updated.reviewer?.customModels).toEqual([]);
    expect(updated.planner.customModels).toEqual(['my-custom-planner', 'other-planner-model']);
  });

  it('does not clear planner.model when it points to a different model', () => {
    const config = makeConfigWithCustomModels();
    const updated = removeCustomModel(config, 'planner', 'other-planner-model');
    expect(updated.planner.model).toBe('my-custom-planner');
  });

  it('removes inactive implementer custom models and reassigns model when deleting the active one', () => {
    const config = makeConfigWithCustomModels();
    const updatedInactive = removeCustomModel(config, 'implementer', 'other-impl-model');
    expect(updatedInactive.implementer.customModels).toEqual(['my-custom-impl']);

    const updatedActive = removeCustomModel(config, 'implementer', 'my-custom-impl');
    expect(updatedActive.implementer.customModels).toEqual(['other-impl-model']);
    expect(updatedActive.implementer.model).toBe('other-impl-model');
  });

  it('does not clear implementer.model when it points to a different model', () => {
    const config = makeConfigWithCustomModels();
    const updated = removeCustomModel(config, 'implementer', 'other-impl-model');
    expect(updated.implementer.model).toBe('my-custom-impl');
  });

  it('leaves customModels empty when removing from a config with no custom models', () => {
    const config = makeBaseConfig();
    const updated = removeCustomModel(config, 'implementer', 'nonexistent');
    expect(updated.implementer.customModels).toEqual([]);
  });

  it('keeps an explicit required model when deleting its last custom-model entry', () => {
    const config: Config = {
      ...makeBaseConfig(),
      implementer: {
        kind: 'api' as const,
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'the-only-custom',
        contextLength: 8192,
        temperature: 0.3,
        customModels: ['the-only-custom'],
      },
    };
    const updated = removeCustomModel(config, 'implementer', 'the-only-custom');
    expect(updated.implementer.customModels).toEqual([]);
    expect(updated.implementer.model).toBe('the-only-custom');
  });

  it('uses model absence when deleting the active last custom model from a CLI', () => {
    const config: Config = {
      ...makeBaseConfig(),
      implementer: {
        kind: 'cli',
        tool: 'codex',
        model: 'the-only-custom',
        customModels: ['the-only-custom'],
      },
    };
    const updated = removeCustomModel(config, 'implementer', 'the-only-custom');
    expect(updated.implementer.customModels).toEqual([]);
    expect(updated.implementer.model).toBeUndefined();
    expect('model' in updated.implementer).toBe(false);
  });
});
