import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { detectCapabilities } from './capabilities.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { Config } from '../../core/schemas/config.js';

describe('detectCapabilities', () => {
  it('returns config contextLength for non-api implementer without throwing', async () => {
    const config = {
      implementer: {
        kind: 'cli' as const,
        tool: 'codex' as const,
        model: 'gpt-5.4-mini',
        contextLength: 32768,
      },
      planner: { kind: 'cli' as const, tool: 'claude-code' as const },
    } as Config;

    const result = await detectCapabilities(config);
    expect(result.contextLength).toBe(32768);
    expect(result.origin).toBe('config');
  });

  it('returns 32768 fallback when nothing resolves', async () => {
    const config = {
      implementer: { kind: 'cli' as const, tool: 'codex' as const, model: 'gpt-5.4-mini' },
      planner: { kind: 'cli' as const, tool: 'claude-code' as const },
    } as Config;

    const result = await detectCapabilities(config);
    expect(result.contextLength).toBe(32768);
    expect(result.origin).toBe('fallback');
  });

  it('resolves a CLI tool under automatic model selection from its bundled catalog', async () => {
    const config = {
      implementer: { kind: 'cli' as const, tool: 'codex' as const, model: 'auto' },
      planner: { kind: 'cli' as const, tool: 'claude-code' as const },
    } as Config;

    const result = await detectCapabilities(config);
    expect(result.contextLength).toBe(272_000);
    expect(result.origin).toBe('catalog');
  });

  describe('api-kind precedence', () => {
    setupFetchMock();

    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env.SPLITBRIEF_CONTEXT_LENGTH;
      delete process.env.SPLITBRIEF_CONTEXT_LENGTH;
    });

    afterEach(() => {
      if (savedEnv === undefined) delete process.env.SPLITBRIEF_CONTEXT_LENGTH;
      else process.env.SPLITBRIEF_CONTEXT_LENGTH = savedEnv;
    });

    function ollamaConfig(contextLength?: number): Config {
      return {
        implementer: {
          kind: 'api' as const,
          provider: 'ollama' as const,
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen:7b',
          ...(contextLength !== undefined ? { contextLength } : {}),
        },
        planner: { kind: 'cli' as const, tool: 'claude-code' as const },
      } as Config;
    }

    function mockDetectedContext(num: number): void {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ parameters: `num_ctx ${num}` }), { status: 200 }),
      );
    }

    function deepseekConfig(): Config {
      const config = makeConfig({
        implementer: {
          kind: 'api',
          provider: 'deepseek',
          service: 'deepseek',
          offering: 'payg',
          apiBase: 'https://api.deepseek.com/v1',
          apiKey: 'test-key',
          model: 'deepseek-v4-flash',
        },
      });
      delete config.implementer.contextLength;
      return config;
    }

    it('env SPLITBRIEF_CONTEXT_LENGTH wins over provider detection', async () => {
      process.env.SPLITBRIEF_CONTEXT_LENGTH = '4096';
      mockDetectedContext(131072);

      const result = await detectCapabilities(ollamaConfig());

      expect(result.contextLength).toBe(4096);
      expect(result.origin).toBe('env');
    });

    it('explicit config contextLength wins over provider detection', async () => {
      mockDetectedContext(131072);

      const result = await detectCapabilities(ollamaConfig(16384));

      expect(result.contextLength).toBe(16384);
      expect(result.origin).toBe('config');
    });

    it('prefers live detection over catalog', async () => {
      mockDetectedContext(131072);

      const result = await detectCapabilities(ollamaConfig());

      expect(result.contextLength).toBe(131072);
      expect(result.origin).toBe('detected');
    });

    it('falls back to the bundled catalog entry when detection fails', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('offline'));

      const result = await detectCapabilities(deepseekConfig());

      expect(result.contextLength).toBe(1_000_000);
      expect(result.origin).toBe('catalog');
    });

    // This probe runs during store init, before the TUI paints. A first-run
    // user with no Ollama used to get `detectContextLength(ollama): fetch
    // failed` — an internal probe name and a bare fetch error — as the first
    // thing the product ever said to them.
    it('writes nothing to stderr when a local endpoint is not listening', async () => {
      // process.stderr is a sanctioned global spy — see docs/TESTING.md.
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('fetch failed'));

      try {
        const result = await detectCapabilities(ollamaConfig());

        expect(result.origin).toBe('fallback');
        expect(stderr).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
    });

    it('still reports a detection failure that is not an unreachable endpoint', async () => {
      // process.stderr is a sanctioned global spy — see docs/TESTING.md.
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error('malformed provider response'));

      try {
        await detectCapabilities(ollamaConfig());

        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining('detectContextLength(ollama): malformed provider response'),
        );
      } finally {
        stderr.mockRestore();
      }
    });
  });
});
