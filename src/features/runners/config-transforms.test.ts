import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import YAML from 'yaml';
import { createDefaultConfig, writeConfig } from '../../core/config/load/io.js';
import { apiKeyErrors } from '../../core/config/load/validation/credentials.js';
import { readCustomCommandCatalog } from '../../core/config/custom-command-catalog.js';
import { fromYaml } from '../../core/config/load/transform.js';
import { getProviderDisplayName } from '../../core/providers/catalog.js';
import { defaultCliAuthChannel } from '../../core/runners/cli-tool-catalog.js';
import { ConfigSchema } from '../../core/schemas/config.js';
import type { Config } from '../../core/schemas/config.js';
import { configStore } from '../../stores/project/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { realPickerOption } from '#testing/helpers/runner-picker.js';
import {
  addCustomCommand,
  commitCustomCommand,
  commitCustomModel,
  commitImplementerSelection,
  commitPlannerTierSelection,
  deleteCustomCommand,
  editCustomCommand,
  inheritsPlannerSeat,
  persistSynthesizedCustomCommand,
  previewCustomCommandEdit,
  removeCustomModel,
  selectCustomCommand,
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
      provider: together
      service: together
      offering: payg
      api_base: https://api.together.ai/v1
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
  const agentSdkSelection = realPickerOption('planner', 'agent-sdk');

  it('commits planner Agent SDK selections with the explicit kind', () => {
    const { config: updated } = commitPlannerTierSelection({
      config: makeBaseConfig(),
      role: 'planner',
      selection: agentSdkSelection,
      model: { id: 'claude-opus-4-6' },
    });

    expect(updated.planner.kind).toBe('agent-sdk');
    if (updated.planner.kind === 'agent-sdk') {
      expect(updated.planner.model).toBe('claude-opus-4-6');
    }
  });

  it('commits implementer Agent SDK selections with the explicit kind', () => {
    const { config: updated } = commitImplementerSelection({
      config: makeBaseConfig(),
      selection: agentSdkSelection,
      model: { id: 'claude-sonnet-4-6' },
    });

    expect(updated.implementer.kind).toBe('agent-sdk');
    if (updated.implementer.kind === 'agent-sdk') {
      expect(updated.implementer.model).toBe('claude-sonnet-4-6');
    }
  });

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
      selection: realPickerOption('implementer', 'together'),
      model: null,
    });

    expect(updated.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      kind: 'api',
      provider: 'together',
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
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        apiBase: 'https://openrouter.ai/api/v1',
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
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        apiBase: 'https://openrouter.ai/api/v1',
        model: 'source-model',
        customModels: ['source-model', 'source-only-model'],
      },
    };

    expect(() =>
      commitImplementerSelection({
        config,
        selection: realPickerOption('implementer', 'anthropic'),
        model: null,
      }),
    ).toThrow(/model/);
  });

  it('switches planners from shell to api when selecting an API provider', () => {
    const { config: updated } = commitPlannerTierSelection({
      config: makeBaseConfig(),
      role: 'planner',
      selection: realPickerOption('planner', 'anthropic'),
      model: { id: 'claude-sonnet-4-6' },
    });

    expect(updated.planner.kind).toBe('api');
    if (updated.planner.kind === 'api') {
      expect(updated.planner.provider).toBe('anthropic');
      expect(updated.planner.apiBase).toBe('https://api.anthropic.com/v1');
    }
  });

  it('preserves optional top-level config sections when committing picker selections', () => {
    const config = makeConfigWithOptionalSections();
    const { config: updated } = commitPlannerTierSelection({
      config,
      role: 'planner',
      selection: realPickerOption('planner', 'anthropic'),
      model: { id: 'claude-sonnet-4-6' },
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
      selection: realPickerOption('implementer', 'together'),
      model: { id: 'selected-model' },
    });
    const selectedApi = selectedModel.implementerProfiles?.profiles['active-cloud'];
    expect(selectedApi).toMatchObject({
      kind: 'api',
      provider: 'together',
      apiBase: 'https://api.together.ai/v1',
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
      selection: realPickerOption('implementer', 'together'),
      modelName: 'custom-added',
      customModels: ['existing-model'],
    });
    expect(customAdded.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      model: 'custom-added',
      customModels: ['existing-model', 'custom-added'],
      apiBase: 'https://api.together.ai/v1',
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

describe('effort across a seat switch', () => {
  function plannerWithEffort(): Config {
    return makeConfig({
      planner: { kind: 'cli', tool: 'claude-code', model: 'auto', effort: 'high' },
    });
  }

  it('clears effort when the chosen tool has no effort channel and names that tool', () => {
    const { config: updated, notice } = commitPlannerTierSelection({
      config: plannerWithEffort(),
      role: 'planner',
      selection: realPickerOption('planner', 'codex'),
      model: { id: 'auto' },
    });

    expect(updated.planner).toMatchObject({ kind: 'cli', tool: 'codex' });
    expect(updated.planner).not.toHaveProperty('effort');
    expect(notice).toContain(getProviderDisplayName('codex'));
    expect(notice).toContain('high');
  });

  it('keeps effort when the chosen seat has an effort channel', () => {
    const { config: updated, notice } = commitPlannerTierSelection({
      config: plannerWithEffort(),
      role: 'planner',
      selection: realPickerOption('planner', 'agent-sdk'),
      model: { id: 'claude-opus-4-6' },
    });

    expect(updated.planner).toMatchObject({ kind: 'agent-sdk', effort: 'high' });
    expect(notice).toBeUndefined();
  });

  it('keeps effort when the chosen API seat resolves Auto to an effort-capable model', () => {
    const { config: updated, notice } = commitPlannerTierSelection({
      config: plannerWithEffort(),
      role: 'planner',
      selection: realPickerOption('planner', 'anthropic'),
      model: { id: 'auto' },
    });

    expect(updated.planner).toMatchObject({ kind: 'api', provider: 'anthropic', effort: 'high' });
    expect(notice).toBeUndefined();
  });

  it('clears effort on the implementer seat, where a CLI tool has no effort channel', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'codex', model: 'auto', effort: 'high' },
    });

    const { config: updated, notice } = commitImplementerSelection({
      config,
      selection: realPickerOption('implementer', 'codex'),
      model: { id: 'auto' },
    });

    expect(updated.implementer).not.toHaveProperty('effort');
    expect(notice).toBeDefined();
  });

  it('keeps effort on a Claude Code implementer seat', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'claude-code', model: 'auto', effort: 'high' },
    });

    const { config: updated, notice } = commitImplementerSelection({
      config,
      selection: realPickerOption('implementer', 'claude-code'),
      model: { id: 'auto' },
    });

    expect(updated.implementer).toMatchObject({
      kind: 'cli',
      tool: 'claude-code',
      effort: 'high',
    });
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

  it('does not carry the planner inline API key onto a reviewer on another provider', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openai',
        service: 'openai',
        offering: 'payg',
        apiBase: 'https://api.openai.com/v1',
        apiKey: 'sk-planner-secret',
        model: 'gpt-5',
      },
    });

    const { config: updated } = commitPlannerTierSelection({
      config,
      role: 'reviewer',
      selection: realPickerOption('planner', 'openrouter'),
      model: { id: 'x-ai/grok-4' },
    });

    expect(updated.reviewer).toMatchObject({ kind: 'api', provider: 'openrouter' });
    expect(JSON.stringify(updated.reviewer)).not.toContain('sk-planner-secret');
    expect(updated.planner).toMatchObject({ apiKey: 'sk-planner-secret' });
  });

  it('leaves a same-provider reviewer with a usable credential', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openai',
        service: 'openai',
        offering: 'payg',
        apiBase: 'https://api.openai.com/v1',
        apiKey: 'sk-planner-secret',
        model: 'gpt-5',
      },
    });

    const { config: updated } = commitPlannerTierSelection({
      config,
      role: 'reviewer',
      selection: realPickerOption('planner', 'openai'),
      model: { id: 'gpt-5' },
    });

    expect(apiKeyErrors(updated).filter((error) => error.path.startsWith('reviewer'))).toEqual([]);
    vi.unstubAllEnvs();
  });

  it('carries the planner env API key reference into a reviewer seeded from the planner', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        apiBase: 'https://openrouter.ai/api/v1',
        apiKey: 'env:MY_OPENROUTER_KEY',
        model: 'x-ai/grok-4',
      },
    });

    const { config: updated } = commitPlannerTierSelection({
      config,
      role: 'reviewer',
      selection: realPickerOption('planner', 'openrouter'),
      model: { id: 'x-ai/grok-4' },
    });

    expect(updated.reviewer).toMatchObject({ apiKey: 'env:MY_OPENROUTER_KEY' });
  });

  it('seeds the reviewer with a custom model without touching the planner', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openai',
        service: 'openai',
        offering: 'payg',
        apiBase: 'https://api.openai.com/v1',
        apiKey: 'sk-planner-secret',
        model: 'gpt-5',
      },
    });
    const plannerBefore = JSON.stringify(config.planner);

    const updated = commitCustomModel({
      config,
      role: 'reviewer',
      selection: realPickerOption('planner', 'openai'),
      modelName: 'my-model',
      customModels: ['gpt-5'],
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
        kind: 'api' as const,
        provider: 'openrouter',
        service: 'openrouter',
        offering: 'payg',
        apiBase: 'https://openrouter.ai/api/v1',
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

const catalogDefinition = {
  label: 'Review changes',
  contract: 'output' as const,
  executable: './tools/review',
  argv: ['--json'],
  outputFormat: 'jsonl' as const,
  idleWarnMs: 4_000,
  idleKillMs: 8_000,
  env: ['REVIEW_TOKEN'],
};

describe('custom command catalog transforms', () => {
  it('adds and selects only the initiating role, then selects the shared definition for the other role', () => {
    const before = namedImplementerProfileConfig();
    const dormant = before.implementerProfiles?.profiles['dormant-local'];
    const added = addCustomCommand({
      config: before,
      role: 'planner',
      id: 'review',
      definition: catalogDefinition,
    });
    expect(added.kind).toBe('added');
    if (added.kind !== 'added') return;
    const plannerAdded = added.config;

    expect(plannerAdded.customCommands).toEqual({ review: catalogDefinition });
    expect(plannerAdded.planner).toMatchObject({
      kind: 'shell',
      command: './tools/review',
      args: ['--json'],
      env: ['REVIEW_TOKEN'],
    });
    expect(plannerAdded.implementer).toEqual(before.implementer);
    expect(plannerAdded.implementerProfiles).toEqual(before.implementerProfiles);

    const selected = selectCustomCommand({
      config: plannerAdded,
      role: 'implementer',
      id: 'review',
    });
    expect(selected.kind).toBe('selected');
    if (selected.kind !== 'selected') return;
    expect(selected.config.planner).toEqual(plannerAdded.planner);
    expect(selected.config.implementer).toMatchObject({
      kind: 'shell',
      command: './tools/review',
      model: 'existing-model',
      env: ['REVIEW_TOKEN'],
    });
    expect(selected.config.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      kind: 'shell',
      command: './tools/review',
      model: 'existing-model',
      label: 'Active cloud',
      costTier: 'cheap',
    });
    expect(selected.config.implementerProfiles?.profiles['dormant-local']).toEqual(dormant);
  });

  it('refuses a duplicate ID without replacing the catalog or orphaning its consumers', () => {
    const oldDefinition = {
      label: 'Shared review',
      contract: 'output' as const,
      executable: './tools/old-review',
    };
    const otherDefinition = {
      label: 'Other command',
      contract: 'direct' as const,
      executable: './tools/other',
    };
    const config: Config = {
      ...createDefaultConfig(),
      customCommands: { shared: oldDefinition, other: otherDefinition },
      planner: { kind: 'shell', command: './tools/old-review', model: 'planner-model' },
      implementer: {
        kind: 'shell',
        command: './tools/old-review',
        model: 'implementer-model',
      },
    };
    const before = structuredClone(config);
    const collision = addCustomCommand({
      config,
      role: 'planner',
      id: 'shared',
      definition: {
        label: 'Replacement',
        contract: 'direct',
        executable: './tools/replacement',
      },
    });

    expect(collision).toEqual({ kind: 'already-exists', id: 'shared' });
    expect('config' in collision).toBe(false);
    expect(config).toEqual(before);

    const preview = previewCustomCommandEdit(config, 'shared');
    expect(preview.kind).toBe('ready');
    if (preview.kind !== 'ready') return;
    expect(preview.consumers.map(({ id }) => id)).toEqual(['planner', 'implementer']);
    const edited = editCustomCommand({
      config,
      id: 'shared',
      definition: {
        label: 'Replacement',
        contract: 'direct',
        executable: './tools/replacement',
      },
    });
    expect(edited.kind).toBe('edited');
    if (edited.kind !== 'edited') return;
    expect(edited.config.customCommands?.other).toEqual(otherDefinition);
    expect(edited.config.planner).toMatchObject({
      kind: 'agent',
      command: './tools/replacement',
    });
    expect(edited.config.implementer).toMatchObject({
      kind: 'agent',
      command: './tools/replacement',
    });
  });

  it('previews and updates every exact consumer while preserving a diverged profile', () => {
    const matchingRunner = {
      kind: 'shell' as const,
      command: './tools/review',
      args: ['--json'],
      outputFormat: 'jsonl' as const,
      idleWarnMs: 4_000,
      idleKillMs: 8_000,
      env: ['REVIEW_TOKEN'],
    };
    const config: Config = {
      ...createDefaultConfig(),
      customCommands: { review: catalogDefinition },
      planner: { ...matchingRunner, model: 'planner-model' },
      implementer: { ...matchingRunner, model: 'implementer-model' },
      implementerProfiles: {
        default: 'default-review',
        profiles: {
          'default-review': {
            ...matchingRunner,
            model: 'default-model',
            label: 'Default review',
          },
          dormant: { ...matchingRunner, model: 'dormant-model' },
          diverged: {
            ...matchingRunner,
            env: ['OTHER_TOKEN'],
            model: 'diverged-model',
          },
        },
      },
    };
    const preview = previewCustomCommandEdit(config, 'review');
    expect(preview.kind).toBe('ready');
    if (preview.kind !== 'ready') return;
    expect(preview.consumers.map(({ id }) => id)).toEqual([
      'planner',
      'implementer',
      'implementerProfiles.default-review',
      'implementerProfiles.dormant',
    ]);

    const replacement = {
      ...catalogDefinition,
      label: 'Apply review',
      contract: 'direct' as const,
      executable: './tools/apply-review',
      env: ['APPLY_TOKEN'],
    };
    const result = editCustomCommand({ config, id: 'review', definition: replacement });
    expect(result.kind).toBe('edited');
    if (result.kind !== 'edited') return;
    expect(result.consumers).toEqual(preview.consumers);
    expect(result.config.customCommands?.review).toEqual(replacement);
    expect(result.config.planner).toMatchObject({
      kind: 'agent',
      command: './tools/apply-review',
      model: 'planner-model',
      env: ['APPLY_TOKEN'],
    });
    expect(result.config.implementerProfiles?.profiles.dormant).toMatchObject({
      kind: 'agent',
      command: './tools/apply-review',
      model: 'dormant-model',
    });
    expect(result.config.implementerProfiles?.profiles.diverged).toEqual(
      config.implementerProfiles?.profiles.diverged,
    );
  });

  it('refuses deletion of a command only the reviewer runs', () => {
    const added = addCustomCommand({
      config: createDefaultConfig(),
      role: 'reviewer',
      id: 'review',
      definition: catalogDefinition,
    });
    expect(added.kind).toBe('added');
    if (added.kind !== 'added') return;

    expect(deleteCustomCommand(added.config, 'review')).toMatchObject({
      kind: 'blocked',
      consumers: [expect.objectContaining({ id: 'reviewer' })],
    });
  });

  it('refuses active deletion and removes the top-level block after deleting the final unused row', () => {
    const added = addCustomCommand({
      config: createDefaultConfig(),
      role: 'planner',
      id: 'review',
      definition: catalogDefinition,
    });
    expect(added.kind).toBe('added');
    if (added.kind !== 'added') return;
    const blocked = deleteCustomCommand(added.config, 'review');
    expect(blocked).toMatchObject({
      kind: 'blocked',
      consumers: [expect.objectContaining({ id: 'planner' })],
    });

    const unused: Config = {
      ...createDefaultConfig(),
      customCommands: { review: catalogDefinition },
    };
    const deleted = deleteCustomCommand(unused, 'review');
    expect(deleted.kind).toBe('deleted');
    if (deleted.kind !== 'deleted') return;
    expect('customCommands' in deleted.config).toBe(false);
  });

  it('blocks deletion of a reviewer-bound command and re-points the reviewer on edit', () => {
    const definition = {
      label: 'Review',
      contract: 'output' as const,
      executable: './tools/review',
    };
    const config: Config = {
      ...createDefaultConfig(),
      customCommands: { review: definition },
      reviewer: { kind: 'shell', command: './tools/review', model: 'reviewer-model' },
    };

    expect(deleteCustomCommand(config, 'review')).toMatchObject({
      kind: 'blocked',
      consumers: [expect.objectContaining({ id: 'reviewer' })],
    });

    const edited = editCustomCommand({
      config,
      id: 'review',
      definition: { ...definition, executable: './tools/review-v2' },
    });
    expect(edited.kind).toBe('edited');
    if (edited.kind !== 'edited') return;
    expect(edited.config.reviewer).toMatchObject({ kind: 'shell', command: './tools/review-v2' });
    expect(edited.config.planner).toEqual(config.planner);
  });

  it('persists a safe synthesized row only through the explicit transform and never persists unsafe material', () => {
    const safeConfig: Config = {
      ...createDefaultConfig(),
      planner: { kind: 'shell', command: './tools/review', args: ['--json'] },
    };
    const safeCatalog = readCustomCommandCatalog(safeConfig);
    const safe = safeCatalog.legacy.find((entry) => entry.kind === 'safe');
    expect(safeConfig.customCommands).toBeUndefined();
    expect(safe?.kind).toBe('safe');
    if (safe?.kind !== 'safe') return;

    const persisted = persistSynthesizedCustomCommand({
      config: safeConfig,
      role: 'planner',
      id: 'legacy-review',
      entry: safe,
    });
    expect(persisted.kind).toBe('added');
    if (persisted.kind !== 'added') return;
    expect(persisted.config.customCommands?.['legacy-review']).toMatchObject({
      contract: 'output',
      executable: './tools/review',
      argv: ['--json'],
    });

    const secret = 'ghp_this_must_not_be_persisted';
    const unsafeConfig: Config = {
      ...createDefaultConfig(),
      planner: { kind: 'shell', command: './tools/review', args: [`--token=${secret}`] },
    };
    const unsafeCatalog = readCustomCommandCatalog(unsafeConfig);
    expect(unsafeCatalog.legacy).toEqual([
      expect.objectContaining({ kind: 'unsafe', opaqueId: expect.any(String) }),
    ]);
    expect(JSON.stringify(unsafeCatalog)).not.toContain(secret);
    expect(unsafeConfig.customCommands).toBeUndefined();
  });

  it('survives the accepted config transaction and a fresh store reload', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-t025-'));
    try {
      writeConfig(projectDir, createDefaultConfig());
      configStore.load(projectDir);
      const current = configStore.get().config;
      expect(current).not.toBeNull();
      if (current === null) return;
      const added = addCustomCommand({
        config: current,
        role: 'planner',
        id: 'review',
        definition: catalogDefinition,
      });
      expect(added.kind).toBe('added');
      if (added.kind !== 'added') return;
      await expect(configStore.save(added.config)).resolves.toMatchObject({
        kind: 'saved',
        ok: true,
      });

      configStore.__testReset();
      configStore.load(projectDir);
      expect(configStore.get().config?.customCommands?.review).toEqual(catalogDefinition);
      expect(configStore.get().config?.planner).toMatchObject({
        kind: 'shell',
        command: './tools/review',
        env: ['REVIEW_TOKEN'],
      });
    } finally {
      configStore.__testReset();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
