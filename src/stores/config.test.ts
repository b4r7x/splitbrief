import { describe, it, expect, beforeEach, vi } from 'vitest';
import { configStore } from './config.js';

vi.mock('../core/config.js', () => ({
  loadConfig: vi.fn(() => ({
    planner: { tool: 'claude-code', model: 'opus' },
    implementer: { provider: 'ollama', model: 'qwen2.5-coder', contextLength: 8192 },
    workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none', mode: 'standard' },
    theme: 'dark',
    sessions: { scope: 'project' },
  })),
  writeConfig: vi.fn(),
}));

import { loadConfig, writeConfig } from '../core/config.js';
import { feedbackStore } from './error.js';

describe('configStore', () => {
  beforeEach(() => configStore.reset());

  it('starts empty', () => {
    expect(configStore.get().config).toBeNull();
    expect(configStore.get().projectDir).toBe('');
  });

  it('loads config from disk', () => {
    configStore.load('/tmp/project');
    expect(configStore.get().projectDir).toBe('/tmp/project');
    expect(configStore.get().config!.planner.tool).toBe('claude-code');
  });

  it('applies overrides', () => {
    configStore.load('/tmp/project', { implementer: { model: 'custom-model' } });
    expect(configStore.get().config!.implementer.model).toBe('custom-model');
  });

  it('reload re-reads config with overrides', () => {
    configStore.load('/tmp/project', { implementer: { model: 'a' } });
    configStore.reload();
    expect(configStore.get().config!.implementer.model).toBe('a');
  });

  it('autoApprove undefined does not override config-file values', () => {
    vi.mocked(loadConfig).mockReturnValueOnce({
      planner: { tool: 'claude-code', model: 'opus' },
      implementer: { provider: 'ollama', model: 'qwen2.5-coder', contextLength: 8192 },
      theme: 'dark',
      sessions: { scope: 'project' },
      workflow: { autoApproveSpec: true, autoApprovePlan: true, maxRetries: 3, commitStrategy: 'none' },
    } as any);
    configStore.load('/tmp/project', { autoApprove: undefined });
    expect(configStore.get().config!.workflow.autoApproveSpec).toBe(true);
    expect(configStore.get().config!.workflow.autoApprovePlan).toBe(true);
  });

  it('applies implementerOverride to implementer.provider', () => {
    configStore.load('/tmp/project', { implementer: { provider: 'deepseek' } });
    expect(configStore.get().config!.implementer.provider).toBe('deepseek');
  });

  it('applies implementerModelOverride to implementer.model', () => {
    configStore.load('/tmp/project', { implementer: { model: 'deepseek-r1' } });
    expect(configStore.get().config!.implementer.model).toBe('deepseek-r1');
  });

  it('applies plannerCommandOverride to planner.command', () => {
    configStore.load('/tmp/project', { planner: { command: 'my-planner' } });
    expect(configStore.get().config!.planner.command).toBe('my-planner');
  });

  it('applies plannerOverride to planner.tool', () => {
    configStore.load('/tmp/project', { planner: { tool: 'aider' } });
    expect(configStore.get().config!.planner.tool).toBe('aider');
  });

  it('applies plannerModelOverride to planner.model', () => {
    configStore.load('/tmp/project', { planner: { model: 'opus' } });
    expect(configStore.get().config!.planner.model).toBe('opus');
  });

  it('applies contextLengthOverride to implementer.contextLength', () => {
    configStore.load('/tmp/project', { contextLength: 16384 });
    expect(configStore.get().config!.implementer.contextLength).toBe(16384);
  });

  it('applies implementerCommandOverride to implementer.command', () => {
    configStore.load('/tmp/project', { implementer: { command: 'my-impl' } });
    expect(configStore.get().config!.implementer.command).toBe('my-impl');
  });

  it('applies valid modeOverride to workflow.mode', () => {
    configStore.load('/tmp/project', { mode: 'full' });
    expect(configStore.get().config!.workflow.mode).toBe('full');
  });
});

describe('configStore.save', () => {
  beforeEach(() => {
    configStore.reset();
    feedbackStore.reset();
    vi.clearAllMocks();
  });

  it('throws when save is called before load', () => {
    expect(() => configStore.save({} as any)).toThrow('configStore.load must be called before save');
  });

  it('writes config to disk and updates store', () => {
    configStore.load('/tmp/project');
    const updated = { ...configStore.get().config!, theme: 'mono' as const };
    configStore.save(updated);
    expect(writeConfig).toHaveBeenCalledWith('/tmp/project', updated);
    expect(configStore.get().config!.theme).toBe('mono');
  });

  it('calls feedbackStore.setError when writeConfig throws', () => {
    configStore.load('/tmp/project');
    vi.mocked(writeConfig).mockImplementationOnce(() => { throw new Error('disk full'); });
    const spy = vi.spyOn(feedbackStore, 'setError');
    configStore.save(configStore.get().config!);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    spy.mockRestore();
  });

  it('save does not re-apply CLI overrides', () => {
    configStore.load('/tmp/project', { implementer: { model: 'custom' } });
    expect(configStore.get().config!.implementer.model).toBe('custom');
    const updated = { ...configStore.get().config!, implementer: { ...configStore.get().config!.implementer, model: 'picker-choice' } };
    configStore.save(updated);
    expect(configStore.get().config!.implementer.model).toBe('picker-choice');
  });

  it('reload still applies CLI overrides', () => {
    configStore.load('/tmp/project', { implementer: { model: 'custom' } });
    configStore.reload();
    expect(configStore.get().config!.implementer.model).toBe('custom');
  });

  it('save then reload re-applies overrides, overwriting picker selection', () => {
    configStore.load('/tmp/project', { implementer: { model: 'custom' } });
    const updated = { ...configStore.get().config!, implementer: { ...configStore.get().config!.implementer, model: 'picker-choice' } };
    configStore.save(updated);
    expect(configStore.get().config!.implementer.model).toBe('picker-choice');
    configStore.reload();
    expect(configStore.get().config!.implementer.model).toBe('custom');
  });
});
