import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import { fromYaml } from '../../core/config/load/transform.js';
import { ConfigSchema } from '../../core/schemas/config.js';
import type { Config } from '../../core/schemas/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  commitCustomCommand,
  commitCustomModel,
  commitImplementerSelection,
  commitPlannerSelection,
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
      provider: together
      service: together
      offering: payg
      api_base: https://api.together.xyz/v1
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
  const agentSdkSelection = {
    id: 'agent-sdk',
    displayName: 'Agent SDK',
    kind: 'agent-sdk' as const,
    available: true,
    badge: 'SDK',
  };

  it('commits planner Agent SDK selections with the explicit kind', () => {
    const updated = commitPlannerSelection(makeBaseConfig(), agentSdkSelection, {
      id: 'claude-opus-4-6',
    });

    expect(updated.planner.kind).toBe('agent-sdk');
    if (updated.planner.kind === 'agent-sdk') {
      expect(updated.planner.model).toBe('claude-opus-4-6');
    }
  });

  it('commits implementer Agent SDK selections with the explicit kind', () => {
    const updated = commitImplementerSelection(makeBaseConfig(), agentSdkSelection, {
      id: 'claude-sonnet-4-6',
    });

    expect(updated.implementer.kind).toBe('agent-sdk');
    if (updated.implementer.kind === 'agent-sdk') {
      expect(updated.implementer.model).toBe('claude-sonnet-4-6');
    }
  });

  it('persists an automatic CLI selection as model absence for an existing planner target', () => {
    const config: Config = {
      ...makeBaseConfig(),
      planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
    };

    const updated = commitPlannerSelection(
      config,
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        kind: 'cli',
        available: true,
        badge: 'CLI',
      },
      { id: 'auto' },
    );

    expect(updated.planner).toEqual({ kind: 'cli', tool: 'claude-code' });
  });

  it('persists an automatic CLI selection as model absence for a named implementer profile', () => {
    const config = namedImplementerProfileConfig();
    const updated = commitImplementerSelection(
      config,
      {
        id: 'codex',
        displayName: 'Codex',
        kind: 'cli',
        available: true,
        badge: 'CLI',
      },
      { id: 'AUTO' },
    );

    expect(updated.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      kind: 'cli',
      tool: 'codex',
    });
    expect(updated.implementerProfiles?.profiles['active-cloud']).not.toHaveProperty('model');
  });

  it('switches a named API profile to CLI without parsing the API profile as model-less', () => {
    const config = namedImplementerProfileConfig();
    const updated = commitImplementerSelection(
      config,
      {
        id: 'codex',
        displayName: 'Codex',
        kind: 'cli',
        available: true,
        badge: 'CLI',
      },
      null,
    );

    expect(updated.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      kind: 'cli',
      tool: 'codex',
    });
    expect(updated.implementerProfiles?.profiles['active-cloud']).not.toHaveProperty('model');
  });

  it('preserves an active API model when the API provider remains selected', () => {
    const config = namedImplementerProfileConfig();
    const updated = commitImplementerSelection(
      config,
      {
        id: 'together',
        displayName: 'Together AI',
        kind: 'api',
        available: true,
        badge: 'API',
      },
      null,
    );

    expect(updated.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      kind: 'api',
      provider: 'together',
      model: 'existing-model',
    });
  });

  it('preserves explicit model IDs when committing a CLI selection', () => {
    const updated = commitPlannerSelection(
      makeBaseConfig(),
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        kind: 'cli',
        available: true,
        badge: 'CLI',
      },
      { id: 'sonnet' },
    );

    expect(updated.planner).toEqual({ kind: 'cli', tool: 'claude-code', model: 'sonnet' });
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

    const updated = commitImplementerSelection(
      config,
      {
        id: 'codex',
        displayName: 'Codex',
        kind: 'cli',
        available: true,
        badge: 'CLI',
      },
      null,
    );

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
      commitImplementerSelection(
        config,
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          kind: 'api',
          available: true,
          badge: 'API',
        },
        null,
      ),
    ).toThrow(/model/);
  });

  it('switches planners from shell to api when selecting an API provider', () => {
    const updated = commitPlannerSelection(
      makeBaseConfig(),
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        kind: 'api',
        available: true,
        badge: 'API',
      },
      { id: 'claude-sonnet-4-6' },
    );

    expect(updated.planner.kind).toBe('api');
    if (updated.planner.kind === 'api') {
      expect(updated.planner.provider).toBe('anthropic');
      expect(updated.planner.apiBase).toBe('https://api.anthropic.com/v1');
    }
  });

  it('preserves optional top-level config sections when committing picker selections', () => {
    const config = makeConfigWithOptionalSections();
    const updated = commitPlannerSelection(
      config,
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        kind: 'api',
        available: true,
        badge: 'API',
      },
      { id: 'claude-sonnet-4-6' },
    );

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

    const selectedModel = commitImplementerSelection(
      config,
      {
        id: 'together',
        displayName: 'Together AI',
        kind: 'api',
        available: true,
        badge: 'API',
      },
      { id: 'selected-model' },
    );
    const selectedApi = selectedModel.implementerProfiles?.profiles['active-cloud'];
    expect(selectedApi).toMatchObject({
      kind: 'api',
      provider: 'together',
      apiBase: 'https://api.together.xyz/v1',
      apiKey: 'env:PATH',
      model: 'selected-model',
    });

    const selectedTool = commitImplementerSelection(
      config,
      {
        id: 'codex',
        displayName: 'Codex',
        kind: 'cli',
        available: true,
        badge: 'CLI',
      },
      { id: 'gpt-5.4-mini' },
    );
    expect(selectedTool.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      kind: 'cli',
      tool: 'codex',
      model: 'gpt-5.4-mini',
    });

    const customAdded = commitCustomModel({
      config,
      role: 'implementer',
      selection: {
        id: 'together',
        displayName: 'Together AI',
        kind: 'api',
        available: true,
        badge: 'API',
      },
      modelName: 'custom-added',
      customModels: ['existing-model'],
    });
    expect(customAdded.implementerProfiles?.profiles['active-cloud']).toMatchObject({
      model: 'custom-added',
      customModels: ['existing-model', 'custom-added'],
      apiBase: 'https://api.together.xyz/v1',
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
