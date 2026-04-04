import { describe, it, expect, beforeEach, vi } from 'vitest';
import { configStore } from './config.js';

vi.mock('../core/config.js', () => ({
  loadConfig: vi.fn(() => ({
    planner: { tool: 'claude-code', model: 'opus' },
    implementer: { provider: 'ollama', model: 'qwen2.5-coder', contextLength: 8192 },
    theme: 'dark',
    sessions: { scope: 'project' },
  })),
}));

describe('configStore', () => {
  beforeEach(() => configStore.reset());

  it('starts empty', () => {
    expect(configStore.get().config).toBeNull();
    expect(configStore.get().projectDir).toBe('');
  });

  it('loads config from disk', () => {
    configStore.load('/tmp/project');
    expect(configStore.get().projectDir).toBe('/tmp/project');
    expect(configStore.get().config.planner.tool).toBe('claude-code');
  });

  it('applies overrides', () => {
    configStore.load('/tmp/project', { modelOverride: 'custom-model' });
    expect(configStore.get().config.implementer.model).toBe('custom-model');
  });

  it('reload re-reads config', () => {
    configStore.load('/tmp/project', { modelOverride: 'a' });
    configStore.reload();
    expect(configStore.get().projectDir).toBe('/tmp/project');
  });
});
