import { describe, expect, it } from 'vitest';
import { configuredReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import type { Config } from '../../../core/schemas/config.js';
import { makeBaseConfig } from '#testing/helpers/config-transforms.js';
import { commitCustomCommand, removeCustomModel } from './custom-model.js';
import { inheritsPlannerSeat } from './seat-selection.js';

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
    expect(configuredReviewerRunner(updated)?.customModels).toEqual([]);
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
