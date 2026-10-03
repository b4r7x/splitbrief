import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../../core/schemas/config.js';
import { createApiPlanner } from './api.js';
import { callPlanner } from '#testing/helpers/planner-call.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let server: http.Server;
let port: number;
let realFetch: typeof globalThis.fetch;
type RequestBody = {
  model: string;
  stream: boolean;
  messages: { role: string; content: string }[];
};
let receivedBodies: RequestBody[];
let receivedHeaders: http.IncomingHttpHeaders[];
let receivedCatalogRequests: { pathname: string; limit: string | null }[];
let projectDir: string;
let openAiCompletionChunks: string[];
let openAiCompletionReplies: string[];

function proxyFetchToLocalServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const requestUrl =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(requestUrl);
  if (parsed.hostname === '127.0.0.1' && parsed.port === String(port)) {
    return realFetch(input, init);
  }

  const localUrl = `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`;
  if (input instanceof Request) {
    return realFetch(localUrl, {
      ...init,
      method: input.method,
      headers: input.headers,
      body: input.body,
      signal: input.signal ?? init?.signal,
      redirect: init?.redirect ?? 'manual',
    });
  }
  return realFetch(localUrl, init);
}

function makeApiPlannerConfig(provider: string): Config {
  const service = provider;
  const offering = provider === 'ollama' ? 'local' : 'payg';

  return {
    version: 3,
    planner: {
      kind: 'api',
      provider,
      service,
      offering,
      model: 'test-model',
      apiBase: `http://127.0.0.1:${port}/v1`,
      ...(provider === 'ollama' ? {} : { apiKey: 'test-key' }),
    },
    implementer: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      model: 'test',
      apiBase: 'http://localhost:11434/v1',
      contextLength: 8192,
      temperature: 0.3,
    },
    validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
    workflow: {
      maxRetries: 3,
      compactionFormat: 'auto',
    },
  };
}

function streamSseChunks(
  res: http.ServerResponse,
  chunks: string[],
  finalUsage?: { prompt_tokens: number; completion_tokens: number },
) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const text of chunks) {
    const event = {
      choices: [{ delta: { content: text }, index: 0, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  if (finalUsage) {
    const final = {
      choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
      usage: finalUsage,
    };
    res.write(`data: ${JSON.stringify(final)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

beforeEach(async () => {
  receivedBodies = [];
  receivedHeaders = [];
  receivedCatalogRequests = [];
  openAiCompletionChunks = ['Hello ', 'world'];
  openAiCompletionReplies = [];
  projectDir = createTempDir('api-planner-test');

  server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && requestUrl.pathname === '/v1/models') {
      receivedCatalogRequests.push({
        pathname: requestUrl.pathname,
        limit: requestUrl.searchParams.get('limit'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        receivedHeaders.push(req.headers);
        const reply = openAiCompletionReplies.shift();
        streamSseChunks(res, reply === undefined ? openAiCompletionChunks : [reply], {
          prompt_tokens: 42,
          completion_tokens: 17,
        });
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal('fetch', proxyFetchToLocalServer);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (server.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  cleanupTempDir(projectDir);
});

describe('createApiPlanner', () => {
  it('sends a typed call schema as response_format and a schema-less call without it', async () => {
    const planner = createApiPlanner(makeApiPlannerConfig('ollama'));
    const call = planner.typedCall({
      projectDir,
      callbacks: { onOutput: () => {} },
      seat: 'reviewer',
    });

    await call.invoke({ prompt: 'q', schema: { json: { type: 'object' }, name: 'probe' } });
    await call.invoke({ prompt: 'q' });

    expect(receivedBodies).toHaveLength(2);
    expect(receivedBodies[0]).toMatchObject({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'probe', schema: { type: 'object' } },
      },
    });
    expect(receivedBodies[1]).not.toHaveProperty('response_format');
  });

  it.each([['custom-endpoint'], ['ollama']] as const)(
    'omits max_tokens when the catalog reports no output ceiling for the %s api kind',
    async (provider) => {
      const cfg = makeApiPlannerConfig(provider);
      cfg.planner.contextLength = 5000;
      const planner = createApiPlanner(cfg);

      await callPlanner(planner, {
        prompt: 'the prompt',
        projectDir,
        callbacks: { onOutput: () => {} },
      });

      expect(receivedBodies).toHaveLength(1);
      expect(receivedBodies[0]).not.toHaveProperty('max_tokens');
    },
  );

  it('strips effort for a model that does not support reasoning', async () => {
    const cfg = makeApiPlannerConfig('custom-endpoint');
    cfg.planner.effort = 'high';
    const planner = createApiPlanner(cfg);

    await callPlanner(planner, {
      prompt: 'the prompt',
      projectDir,
      callbacks: { onOutput: () => {} },
    });

    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0]).not.toHaveProperty('reasoning_effort');
  });

  it.each([['ollama'], ['custom-endpoint']] as const)(
    'isAvailable returns true for %s when endpoint responds',
    async (provider) => {
      const planner = createApiPlanner(makeApiPlannerConfig(provider));
      expect(await planner.isAvailable()).toBe(true);
    },
  );

  it('probes the remote model catalog during isAvailable', async () => {
    const planner = createApiPlanner(makeApiPlannerConfig('custom-endpoint'));

    expect(await planner.isAvailable()).toBe(true);
    expect(receivedCatalogRequests.map((request) => request.pathname)).toContain('/v1/models');
  });

  it('isAvailable returns false when endpoint is unreachable', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const planner = createApiPlanner(makeApiPlannerConfig('ollama'));
    expect(await planner.isAvailable()).toBe(false);
  });

  it('throws if model is "auto" for unknown provider', () => {
    const cfg = makeApiPlannerConfig('custom-unknown-provider');
    cfg.planner.model = 'auto';
    expect(() => createApiPlanner(cfg)).toThrow(/API planner requires an explicit model/);
  });

  it('refuses a remote provider with no key configured', () => {
    const cfg: Config = {
      ...makeApiPlannerConfig('custom-endpoint'),
      planner: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        model: 'test-model',
        apiBase: `http://127.0.0.1:${port}/v1`,
      },
    };

    expect(() => createApiPlanner(cfg)).toThrow(/requires an overrides.apiKey/);
  });

  it('rejects over-context calls before dispatching upstream', async () => {
    const cfg = makeApiPlannerConfig('ollama');
    cfg.planner.contextLength = 1;
    const planner = createApiPlanner(cfg);

    await expect(
      callPlanner(planner, {
        prompt: 'this prompt cannot fit the one-token planner window',
        projectDir,
        callbacks: { onOutput: () => {} },
      }),
    ).rejects.toMatchObject({
      kind: 'api-insufficient-context',
    });
    expect(receivedBodies).toEqual([]);
  });

  it('unavailabilityReason surfaces the typed catalog diagnostic for an auth-rejected key', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.writeHead(401);
      res.end();
    });
    const cfg = makeApiPlannerConfig('custom-endpoint');
    const planner = createApiPlanner(cfg);

    expect(await planner.isAvailable()).toBe(false);
    expect(planner.unavailabilityReason?.()).toBe('HTTP 401');
  });

  it('unavailabilityReason surfaces a cause when the endpoint is unreachable', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const planner = createApiPlanner(makeApiPlannerConfig('ollama'));

    expect(await planner.isAvailable()).toBe(false);
    const reason = planner.unavailabilityReason?.();
    expect(reason).toBe('fetch failed');
  });
});
