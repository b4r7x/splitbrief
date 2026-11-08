import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { detectCapabilities, plannerSupportsImages } from './capabilities.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { Config } from '../../core/schemas/config.js';
import type { RunnerConfig } from '../../core/config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { resolveProfileContextLength } from '../orchestrator/context-routing/context-length.js';
import { OBSERVATION_HTTP_TIMEOUT_MS } from '../constants.js';

describe('detectCapabilities', () => {
  // An automatic CLI seat reads the model its tool selects from HOME, the XDG folders and CODEX_HOME.
  let toolHome: string;

  beforeEach(() => {
    toolHome = createTempDir('detect-capabilities-home');
    vi.stubEnv('HOME', toolHome);
    vi.stubEnv('XDG_CONFIG_HOME', join(toolHome, 'config'));
    vi.stubEnv('XDG_STATE_HOME', join(toolHome, 'state'));
    vi.stubEnv('CODEX_HOME', join(toolHome, 'codex'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    cleanupTempDir(toolHome);
  });

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
    expect(result).toEqual({ contextLength: 32768, origin: 'config' });
  });

  it('names no window when nothing resolves', async () => {
    const config = {
      implementer: { kind: 'cli' as const, tool: 'codex' as const, model: 'gpt-5.4-mini' },
      planner: { kind: 'cli' as const, tool: 'claude-code' as const },
    } as Config;

    expect(await detectCapabilities(config)).toBeUndefined();
  });

  it('resolves a CLI tool under automatic model selection from its bundled catalog', async () => {
    const config = {
      implementer: { kind: 'cli' as const, tool: 'codex' as const, model: 'auto' },
      planner: { kind: 'cli' as const, tool: 'claude-code' as const },
    } as Config;

    const result = await detectCapabilities(config);
    expect(result).toEqual({ contextLength: 272_000, origin: 'catalog' });
  });

  // codex 0.164.0 `debug models` lists gpt-6.1-sol at 500000; the bundled row says 272000.
  it('reads a CLI build seat window from the model cache a run reads, so both agree', async () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'codex', model: 'gpt-6.1-sol' },
    });
    const cache = makeModelCacheAccessor({
      catalog: {
        openai: {
          id: 'openai',
          models: { 'gpt-6.1-sol': { id: 'gpt-6.1-sol', limit: { context: 272_000 } } },
        },
      },
      providerModels: { codex: [{ id: 'gpt-6.1-sol', contextLength: 500_000 }] },
    });

    const boot = await detectCapabilities(config, cache);
    const run = resolveProfileContextLength(
      resolveImplementerProfiles(config).defaultProfile,
      32_768,
      cache,
    );

    expect(boot).toEqual({ contextLength: 500_000, origin: 'catalog' });
    expect(run.contextLength).toBe(boot?.contextLength);
  });

  // `kilo models --verbose` lists kilo/openai/gpt-3.5-turbo-0613 at 4095 among 321 rows.
  it('names no window for an automatic Kilo seat whose selection it cannot read', async () => {
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'kilo-code', model: 'auto' } });
    const cache = makeModelCacheAccessor({
      providerModels: {
        'kilo-code': [
          { id: 'kilo/openai/gpt-3.5-turbo-0613', contextLength: 4095 },
          { id: 'kilo/~anthropic/claude-fable-latest', contextLength: 1_000_000 },
        ],
      },
    });

    expect(await detectCapabilities(config, cache)).toBeUndefined();
  });

  it('reads an automatic OpenCode seat at the window of the model OpenCode selects, as the run does', async () => {
    const opencodeState = join(toolHome, 'state', 'opencode');
    mkdirSync(opencodeState, { recursive: true });
    writeFileSync(
      join(opencodeState, 'model.json'),
      JSON.stringify({ recent: [{ providerID: 'openai', modelID: 'gpt-5.6-sol' }] }),
    );
    const cache = makeModelCacheAccessor({
      providerModels: {
        opencode: [
          {
            id: 'openai/text-embedding-3-small',
            contextLength: 8191,
            capabilities: ['type:embedding'],
            supportsToolCalls: false,
          },
          { id: 'opencode-go/glm-5.2', contextLength: 128_000 },
          { id: 'openai/gpt-5.6-sol', contextLength: 1_050_000 },
        ],
      },
    });

    const boot = await detectCapabilities(
      makeConfig({ implementer: { kind: 'cli', tool: 'opencode', model: 'auto' } }),
      cache,
    );
    // Start names the selected model on the seat, so the run reads the prepared config.
    const run = resolveProfileContextLength(
      resolveImplementerProfiles(
        makeConfig({ implementer: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6-sol' } }),
      ).defaultProfile,
      32_768,
      cache,
    );

    expect(boot).toEqual({ contextLength: 1_050_000, origin: 'catalog' });
    expect(run.contextLength).toBe(boot?.contextLength);
  });

  describe('api-kind precedence', () => {
    setupFetchMock();

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

    it('explicit config contextLength wins over provider detection', async () => {
      mockDetectedContext(131072);

      const result = await detectCapabilities(ollamaConfig(16384));

      expect(result).toEqual({ contextLength: 16384, origin: 'config' });
    });

    it('prefers live detection over catalog', async () => {
      mockDetectedContext(131072);

      const result = await detectCapabilities(ollamaConfig());

      expect(result).toEqual({ contextLength: 131072, origin: 'detected' });
    });

    it('names no window when detection fails with no bundled row', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('offline'));

      expect(await detectCapabilities(customEndpointConfig())).toBeUndefined();
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

      expect(await detectCapabilities(config)).toBeUndefined();
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
        expect(await detectCapabilities(ollamaConfig())).toBeUndefined();
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
    'settles %s with no window and no warning once the read passes its bound',
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

          expect(await detected).toBeUndefined();
          expect(stderr).not.toHaveBeenCalled();
        });
      } finally {
        timeout.mockRestore();
        stderr.mockRestore();
      }
    },
  );
});

describe('plannerSupportsImages', () => {
  const noListing = makeModelCacheAccessor();

  it('uses the planner tool channel even before detection', () => {
    expect(plannerSupportsImages(null, noListing)).toBe(false);
    const planners: readonly (readonly [RunnerConfig, boolean])[] = [
      [{ kind: 'cli', tool: 'claude-code' }, true],
      [{ kind: 'cli', tool: 'codex' }, true],
      [{ kind: 'cli', tool: 'opencode' }, true],
      [{ kind: 'cli', tool: 'kilo-code' }, true],
      [{ kind: 'cli', tool: 'copilot' }, true],
      [{ kind: 'cli', tool: 'cursor' }, false],
      [{ kind: 'cli', tool: 'command-code' }, false],
      [{ kind: 'cli', tool: 'antigravity' }, false],
      [{ kind: 'shell', command: 'my-planner', model: 'whatever' }, false],
      [{ kind: 'agent', command: 'my-agent', model: 'whatever' }, false],
    ];
    for (const [planner, supportsImages] of planners) {
      expect(plannerSupportsImages(makeConfig({ planner }), noListing)).toBe(supportsImages);
    }
  });

  it('uses the API planner model fact from its own provider', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'lm-studio',
        apiBase: 'http://localhost:1234/v1',
        model: 'vision',
      },
    });
    const vision = { id: 'vision', supportsImages: true };
    expect(
      plannerSupportsImages(
        config,
        makeModelCacheAccessor({ providerModels: { ollama: [vision] } }),
      ),
    ).toBe(false);
    expect(
      plannerSupportsImages(
        config,
        makeModelCacheAccessor({ providerModels: { 'lm-studio': [vision] } }),
      ),
    ).toBe(true);
    expect(
      plannerSupportsImages(
        config,
        makeModelCacheAccessor({ providerModels: { 'lm-studio': [] } }),
      ),
    ).toBe(false);
    expect(
      plannerSupportsImages(
        config,
        makeModelCacheAccessor({
          providerModels: { 'lm-studio': [{ ...vision, supportsImages: false }] },
        }),
      ),
    ).toBe(false);
  });
});
