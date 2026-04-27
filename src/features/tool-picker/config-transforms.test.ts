import { describe, it, expect } from 'vitest';
import type { Config } from '../../core/schemas/config.js';
import {
  commitCustomCommand,
  commitImplementerSelection,
  commitPlannerSelection,
  removeCustomModel,
} from './config-transforms.js';

function makeBaseConfig(): Config {
  return {
    version: 2,
    planner: {
      kind: 'shell',
      command: 'old-command',
    },
    implementer: {
      kind: 'api',
      provider: 'ollama',
      model: 'llama3',
      apiBase: 'http://localhost:11434/v1',
      contextLength: 8192,
      temperature: 0.3,
    },
    validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
    workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none', persistTranscript: true },
  };
}

function makeConfigWithOptionalSections(): Config {
  return {
    ...makeBaseConfig(),
    codebase: {
      enabled: true,
      tokenBudget: 1234,
      cacheDir: '.diptych-cache',
      include: ['src/**'],
      exclude: ['dist/**'],
    },
    hooks: {
      builtin: { snapshots: false },
    },
    otel: {
      enabled: true,
      serviceName: 'diptych-test',
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
        { id: 'refresh-docs', label: 'Refresh docs', description: 'Refresh documentation', command: '/refresh' },
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

describe('commitCustomCommand', () => {
  it('preserves kind: shell for shell selection', () => {
    const config = makeBaseConfig();
    const updated = commitCustomCommand(config, 'planner', 'my-shell-tool --flag', 'shell');
    expect(updated.planner.kind).toBe('shell');
    if (updated.planner.kind === 'shell') {
      expect(updated.planner.command).toBe('my-shell-tool --flag');
    }
  });

  it('preserves kind: agent for agent selection', () => {
    const config = makeBaseConfig();
    const updated = commitCustomCommand(config, 'planner', 'my-agent-tool --flag', 'agent');
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
    const updated = commitCustomCommand(config, 'implementer', 'new-impl-cmd', 'shell');
    expect(updated.implementer.kind).toBe('shell');
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
    const updated = commitCustomCommand(config, 'implementer', 'new-agent-impl', 'agent');
    expect(updated.implementer.kind).toBe('agent');
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
    const updated = commitPlannerSelection(
      makeBaseConfig(),
      agentSdkSelection,
      { id: 'claude-opus-4-6' },
    );

    expect(updated.planner.kind).toBe('agent-sdk');
    if (updated.planner.kind === 'agent-sdk') {
      expect(updated.planner.model).toBe('claude-opus-4-6');
    }
  });

  it('commits implementer Agent SDK selections with the explicit kind', () => {
    const updated = commitImplementerSelection(
      makeBaseConfig(),
      agentSdkSelection,
      { id: 'claude-sonnet-4-6' },
    );

    expect(updated.implementer.kind).toBe('agent-sdk');
    if (updated.implementer.kind === 'agent-sdk') {
      expect(updated.implementer.model).toBe('claude-sonnet-4-6');
    }
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
});

describe('removeCustomModel', () => {
  function makeConfigWithCustomModels(): Config {
    return {
      ...makeBaseConfig(),
      planner: {
        kind: 'api' as const,
        provider: 'openrouter',
        apiBase: 'https://openrouter.ai/api/v1',
        model: 'my-custom-planner',
        customModels: ['my-custom-planner', 'other-planner-model'],
      },
      implementer: {
        kind: 'api' as const,
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        model: 'my-custom-impl',
        contextLength: 8192,
        temperature: 0.3,
        customModels: ['my-custom-impl', 'other-impl-model'],
      },
    };
  }

  it('removes the model from planner customModels', () => {
    const config = makeConfigWithCustomModels();
    const updated = removeCustomModel(config, 'planner', 'other-planner-model');
    expect(updated.planner.customModels).toEqual(['my-custom-planner']);
  });

  it('clears planner.model when it points to the deleted custom model', () => {
    const config = makeConfigWithCustomModels();
    const updated = removeCustomModel(config, 'planner', 'my-custom-planner');
    expect(updated.planner.customModels).toEqual(['other-planner-model']);
    // planner.model is optional — key should be absent after clearing
    expect(updated.planner.model).toBeUndefined();
    expect('model' in updated.planner).toBe(false);
  });

  it('does not clear planner.model when it points to a different model', () => {
    const config = makeConfigWithCustomModels();
    const updated = removeCustomModel(config, 'planner', 'other-planner-model');
    expect(updated.planner.model).toBe('my-custom-planner');
  });

  it('removes the model from implementer customModels', () => {
    const config = makeConfigWithCustomModels();
    const updated = removeCustomModel(config, 'implementer', 'other-impl-model');
    expect(updated.implementer.customModels).toEqual(['my-custom-impl']);
  });

  it('clears implementer.model when it points to the deleted custom model', () => {
    const config = makeConfigWithCustomModels();
    const updated = removeCustomModel(config, 'implementer', 'my-custom-impl');
    expect(updated.implementer.customModels).toEqual(['other-impl-model']);
    // implementer.model is required (string); falls back to first remaining custom model
    expect(updated.implementer.model).toBe('other-impl-model');
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

  it('falls back to existing model when last custom model is deleted for implementer', () => {
    const config: Config = {
      ...makeBaseConfig(),
      implementer: {
        kind: 'api' as const,
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        model: 'the-only-custom',
        contextLength: 8192,
        temperature: 0.3,
        customModels: ['the-only-custom'],
      },
    };
    const updated = removeCustomModel(config, 'implementer', 'the-only-custom');
    expect(updated.implementer.customModels).toEqual([]);
    // No remaining custom models — keep the old model value (required field)
    expect(updated.implementer.model).toBe('the-only-custom');
  });
});
