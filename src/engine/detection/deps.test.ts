import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createProductionDetectionDeps } from './deps.js';
import { resolveDetectionSourceContexts } from './service/results.js';

function requestUrl(input: string | URL | Request): string {
  if (input instanceof Request) return input.url;
  return typeof input === 'string' ? input : input.toString();
}

async function withLoopbackServer(
  run: (input: Readonly<{ apiBase: string; requests: http.IncomingMessage[] }>) => Promise<void>,
): Promise<void> {
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request);
    if (request.url !== '/api/v1/models') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ models: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a loopback detection test server address.');
  }

  try {
    await run({ apiBase: `http://127.0.0.1:${address.port}/v1`, requests });
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('createProductionDetectionDeps', () => {
  // detectAll runs real readiness probes; an empty PATH keeps these tests off
  // the developer machine's actual CLI binaries (oracle latency is unbounded).
  let realPath: string | undefined;
  let emptyPathDir: string;
  beforeEach(() => {
    realPath = process.env.PATH;
    emptyPathDir = createTempDir('production-deps-empty-path');
    process.env.PATH = emptyPathDir;
  });
  afterEach(() => {
    if (realPath === undefined) delete process.env.PATH;
    else process.env.PATH = realPath;
    cleanupTempDir(emptyPathDir);
  });

  it('binds every discovery lane to the current project, endpoint, channel, and credential domain without storing credential bytes', () => {
    const configA = makeConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' },
      implementer: {
        kind: 'api',
        provider: 'custom-private-provider',
        service: 'custom-private-provider',
        offering: 'payg',
        apiBase: 'https://gateway-a.example.test/v1',
        apiKey: 'sk-private-config-a',
        model: 'gpt-5.4',
      },
    });
    const configB = makeConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5.4' },
      implementer: {
        kind: 'api',
        provider: 'custom-private-provider',
        service: 'custom-private-provider',
        offering: 'payg',
        apiBase: 'https://gateway-b.example.test/v1',
        apiKey: 'sk-private-config-b',
        model: 'gpt-5.4',
      },
    });

    const contextsA = resolveDetectionSourceContexts({
      deps: createProductionDetectionDeps({ config: configA, projectDir: '/projects/a' }),
      projectDir: '/projects/a',
    });
    const contextsB = resolveDetectionSourceContexts({
      deps: createProductionDetectionDeps({ config: configB, projectDir: '/projects/b' }),
      projectDir: '/projects/b',
    });

    expect(contextsA.readiness).not.toBe(contextsB.readiness);
    expect(contextsA.modelsDev).not.toBe(contextsB.modelsDev);
    expect(contextsA.cliModels).not.toBe(contextsB.cliModels);
    expect(JSON.stringify(contextsA)).not.toContain('sk-private-config-a');
    expect(JSON.stringify(contextsB)).not.toContain('sk-private-config-b');
    // The salted readiness/cliModels lanes key pre-change snapshots out.
    expect(contextsA.readiness).toContain(encodeURIComponent('readiness:all-tools:'));
    expect(contextsA.modelsDev).not.toContain('all-tools');
    expect(contextsA.cliModels).toContain(encodeURIComponent('cliModels:per-tool:'));
    expect(contextsA.cliModels).not.toContain(encodeURIComponent('cliModels:all-tools:'));
  });

  it('probes only the configured built-in API endpoint with its raw override held closure-local', async () => {
    await withLoopbackServer(async ({ apiBase, requests }) => {
      const nativeFetch = globalThis.fetch.bind(globalThis);
      const fetchUrls: string[] = [];
      vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        fetchUrls.push(url);
        if (!url.startsWith(apiBase.replace(/\/v1$/, ''))) {
          return Promise.reject(new Error(`Unexpected unselected provider request: ${url}`));
        }
        return nativeFetch(input, init);
      });
      try {
        const config = makeConfig({
          planner: { kind: 'shell', command: 'printf planner' },
          implementer: {
            kind: 'api',
            provider: 'lm-studio',
            apiBase,
            apiKey: 'configured-lm-studio-key',
            model: 'local-model',
          },
        });

        const result = await createProductionDetectionDeps({
          config,
          projectDir: '/projects/configured-lm-studio',
        }).detectAll({ signal: new AbortController().signal });

        expect(fetchUrls).toEqual([`${apiBase.replace(/\/v1$/, '')}/api/v1/models`]);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.headers.authorization).toBe('Bearer configured-lm-studio-key');
        expect(result.providers).toEqual([]);
        expect(result.configuredProviderOutcomes).toEqual([
          expect.objectContaining({
            connection: expect.objectContaining({ role: 'implementer', provider: 'lm-studio' }),
            outcome: expect.objectContaining({ kind: 'success', catalog: 'empty', models: [] }),
          }),
        ]);
        expect(JSON.stringify(result)).not.toContain('configured-lm-studio-key');
        expect(JSON.stringify(result)).not.toContain(apiBase);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }, 20_000);

  it('does not construct or request a custom API provider string', async () => {
    const fetchUrls: string[] = [];
    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      fetchUrls.push(requestUrl(input));
      return Promise.reject(new Error('Custom providers must not be probed.'));
    });
    try {
      const config = makeConfig({
        planner: { kind: 'shell', command: 'printf planner' },
        implementer: {
          kind: 'api',
          provider: 'custom-private-provider',
          service: 'custom-private-provider',
          offering: 'payg',
          apiBase: 'https://custom-private-provider.example/v1',
          apiKey: 'custom-private-key',
          model: 'custom-model',
        },
      });

      const result = await createProductionDetectionDeps({
        config,
        projectDir: '/projects/custom-provider',
      }).detectAll({ signal: new AbortController().signal });

      expect(fetchUrls).toEqual([]);
      expect(result.configuredProviderOutcomes).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('custom-private-key');
    } finally {
      vi.unstubAllGlobals();
    }
  }, 20_000);
});
