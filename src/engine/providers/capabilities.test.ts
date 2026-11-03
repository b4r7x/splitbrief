import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { detectCapabilities } from './capabilities.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { Config } from '../../core/schemas/config.js';
import { OBSERVATION_HTTP_TIMEOUT_MS } from '../constants.js';

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

    function customEndpointConfig(): Config {
      const config = makeConfig({
        implementer: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          apiBase: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'custom-model',
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

    it('falls back to the default window when detection fails with no bundled row', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('offline'));

      const result = await detectCapabilities(customEndpointConfig());

      expect(result.contextLength).toBe(32768);
      expect(result.origin).toBe('fallback');
    });

    it('does not resolve an API implementer named opencode from the CLI bundled rows', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('offline'));
      const config = makeConfig({
        implementer: {
          kind: 'api',
          provider: 'opencode',
          service: 'opencode',
          offering: 'payg',
          apiBase: 'https://my-endpoint.example/v1',
          apiKey: 'test-key',
          model: 'openai/gpt-5.6-sol',
        },
      });
      delete config.implementer.contextLength;

      const result = await detectCapabilities(config);

      expect(result).toEqual({ contextLength: 32_768, origin: 'fallback' });
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
          expect.stringContaining(
            'Could not read the context length of qwen:7b from Ollama: malformed provider response',
          ),
        );
      } finally {
        stderr.mockRestore();
      }
    });
  });
});

describe('detectCapabilities against a local server that accepts the read and never answers', () => {
  async function withSilentServer(
    run: (input: Readonly<{ apiBase: string; requested: Promise<void> }>) => Promise<void>,
  ): Promise<void> {
    let markRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    const server = http.createServer(() => markRequested());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run({ apiBase: `http://127.0.0.1:${port}/v1`, requested });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it.each(['lm-studio', 'llama-cpp', 'ollama'] as const)(
    'settles %s on the fallback window with no warning once the read passes its bound',
    async (provider) => {
      // process.stderr is a sanctioned global spy — see docs/TESTING.md. AbortSignal.timeout is the
      // clock: the test fires the bound once the server holds the request.
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const bounds: { ms: number; controller: AbortController }[] = [];
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const controller = new AbortController();
        bounds.push({ ms, controller });
        return controller.signal;
      });
      try {
        await withSilentServer(async ({ apiBase, requested }) => {
          const config = makeConfig({
            implementer: {
              kind: 'api',
              provider,
              service: provider,
              offering: 'local',
              apiBase,
              model: 'local-model',
            },
          });
          delete config.implementer.contextLength;

          const detected = detectCapabilities(config);
          await requested;
          expect(bounds.map((bound) => bound.ms)).toEqual([OBSERVATION_HTTP_TIMEOUT_MS]);
          for (const { controller } of bounds) {
            controller.abort(
              new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
            );
          }

          expect(await detected).toEqual({ contextLength: 32_768, origin: 'fallback' });
          expect(stderr).not.toHaveBeenCalled();
        });
      } finally {
        timeout.mockRestore();
        stderr.mockRestore();
      }
    },
  );
});
