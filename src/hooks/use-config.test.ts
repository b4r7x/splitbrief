import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';
import { makeConfig } from '#testing/helpers/fixtures.js';

vi.mock('../config.js', () => ({
  loadConfig: () => makeConfig(),
}));

import { useConfig } from './use-config.js';

describe('useConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a config object with default values', () => {
    const { result, unmount } = renderHook(() => useConfig('/tmp/project', {}));
    expect(result.current.config.planner.tool).toBe('claude-code');
    expect(result.current.config.implementer.provider).toBe('ollama');
    expect(result.current.config.implementer.model).toBe('qwen2.5-coder:7b');
    unmount();
  });

  it('applies model override', () => {
    const { result, unmount } = renderHook(() =>
      useConfig('/tmp/project', { modelOverride: 'llama3:8b' }),
    );
    expect(result.current.config.implementer.model).toBe('llama3:8b');
    unmount();
  });

  it('applies provider override', () => {
    const { result, unmount } = renderHook(() =>
      useConfig('/tmp/project', { providerOverride: 'lm-studio' }),
    );
    expect(result.current.config.implementer.provider).toBe('lm-studio');
    unmount();
  });

  it('applies context length override', () => {
    const { result, unmount } = renderHook(() =>
      useConfig('/tmp/project', { contextLengthOverride: 8192 }),
    );
    expect(result.current.config.implementer.contextLength).toBe(8192);
    unmount();
  });

  it('applies planner override', () => {
    const { result, unmount } = renderHook(() =>
      useConfig('/tmp/project', { plannerOverride: 'aider' }),
    );
    expect(result.current.config.planner.tool).toBe('aider');
    unmount();
  });

  it('applies planner model override', () => {
    const { result, unmount } = renderHook(() =>
      useConfig('/tmp/project', { plannerModelOverride: 'opus-4' }),
    );
    expect(result.current.config.planner.model).toBe('opus-4');
    unmount();
  });

  it('applies multiple overrides simultaneously', () => {
    const { result, unmount } = renderHook(() =>
      useConfig('/tmp/project', {
        modelOverride: 'custom-model',
        providerOverride: 'deepseek',
        plannerOverride: 'codex',
      }),
    );
    expect(result.current.config.implementer.model).toBe('custom-model');
    expect(result.current.config.implementer.provider).toBe('deepseek');
    expect(result.current.config.planner.tool).toBe('codex');
    unmount();
  });

  it('exposes reloadConfig function', () => {
    const { result, unmount } = renderHook(() => useConfig('/tmp/project', {}));
    expect(typeof result.current.reloadConfig).toBe('function');
    unmount();
  });
});
