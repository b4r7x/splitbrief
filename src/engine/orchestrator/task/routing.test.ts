import { describe, expect, it } from 'vitest';
import {
  taskConfigForProfile,
  selectedProfileFromDecision,
  createTaskImplementer,
  retryProfileOverrideForTask,
  routingBlockMessage,
} from './routing.js';
import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import type { RoutingDecision } from '../context-routing/types.js';
import type { WorkflowContext } from '../types.js';

describe('taskConfigForProfile', () => {
  it('merges profile config into workflow config', () => {
    const config = { implementer: { provider: 'openai' as const, model: 'gpt-4' } } as WorkflowContext['config'];
    const profile = { config: { provider: 'ollama' as const, model: 'qwen' } } as ResolvedImplementerProfile;
    const result = taskConfigForProfile(config, profile);
    expect(result.implementer).toEqual({ provider: 'ollama', model: 'qwen' });
  });
});

describe('selectedProfileFromDecision', () => {
  it('returns undefined when no profile selected', () => {
    const decision = { selectedProfile: undefined } as RoutingDecision;
    expect(selectedProfileFromDecision([], decision)).toBeUndefined();
  });

  it('finds matching profile by name', () => {
    const profiles = [
      { name: 'local' },
      { name: 'cloud' },
    ] as ResolvedImplementerProfile[];
    const decision = { selectedProfile: 'cloud' } as RoutingDecision;
    expect(selectedProfileFromDecision(profiles, decision)).toEqual(profiles[1]);
  });
});

describe('createTaskImplementer', () => {
  it('returns existing implementer in single mode with default profile', async () => {
    const implementer = { implement: async () => ({ success: true, output: '' }) } as any;
    const wctx = { implementer, bus: {} as any };
    const profile = { isDefault: true, config: {} } as ResolvedImplementerProfile;
    const result = await createTaskImplementer({ wctx: wctx as any, profile, taskConfig: {} as any, singleImplementerMode: true });
    expect(result).toBe(implementer);
  });

  it('creates new implementer when not single mode', async () => {
    const createdImplementer = { implement: async () => ({ success: true, output: '' }) };
    const taskConfig = { implementer: { provider: 'ollama' } };
    let receivedConfig: typeof taskConfig | undefined;
    const factory = (config: typeof taskConfig) => {
      receivedConfig = config;
      return createdImplementer as any;
    };
    const wctx = { implementer: {} as any, bus: {} as any, createImplementer: factory };
    const profile = { isDefault: false, config: { provider: 'ollama' } } as ResolvedImplementerProfile;

    const result = await createTaskImplementer({ wctx: wctx as any, profile, taskConfig: taskConfig as any, singleImplementerMode: false });

    expect(result).toBe(createdImplementer);
    expect(receivedConfig).toBe(taskConfig);
  });
});

describe('retryProfileOverrideForTask', () => {
  it('returns undefined when no override set', () => {
    const wctx = {} as any;
    const task = { id: 'T1' } as any;
    expect(retryProfileOverrideForTask(wctx, task)).toBeUndefined();
  });

  it('returns override when task id matches', () => {
    const wctx = { retryProfileOverride: 'large', retryProfileOverrideTaskId: 'T1' } as any;
    const task = { id: 'T1' } as any;
    expect(retryProfileOverrideForTask(wctx, task)).toBe('large');
  });

  it('returns undefined when task id does not match', () => {
    const wctx = { retryProfileOverride: 'large', retryProfileOverrideTaskId: 'T2' } as any;
    const task = { id: 'T1' } as any;
    expect(retryProfileOverrideForTask(wctx, task)).toBeUndefined();
  });
});

describe('routingBlockMessage', () => {
  it('formats message with estimated tokens', () => {
    const decision = { taskId: 'T1', estimatedTokens: 5000, contextLength: undefined, reason: 'too large' } as RoutingDecision;
    const message = routingBlockMessage(decision);
    expect(message).toContain('T1');
    expect(message).toContain('5000 estimated tokens');
  });

  it('formats message with context length ratio', () => {
    const decision = { taskId: 'T1', estimatedTokens: 5000, contextLength: 4000, reason: 'overflow' } as RoutingDecision;
    const message = routingBlockMessage(decision);
    expect(message).toContain('5000/4000 estimated tokens');
  });
});
