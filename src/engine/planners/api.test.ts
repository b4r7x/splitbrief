import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../../core/schemas/config.js';
import { createApiPlanner } from './api.js';
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

const validPlannerArtifact = `---
id: T001
title: Test task
action: create
file: src/example.ts
depends_on: []
---

# Test plan

### Description
Create the example file.

### Implementation Steps
1. Write the file.

### Tests
- npm test

### Constraints
- Follow project conventions.
`;

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
      persistTranscript: true,
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
        streamSseChunks(res, openAiCompletionChunks, {
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
  it('regenerate sends prompt to chat endpoint and returns parsed text + usage', async () => {
    const planner = createApiPlanner(makeApiPlannerConfig('ollama'));
    const collected: string[] = [];

    const result = await planner.regenerate({
      prompt: 'the prompt',
      projectDir,
      callbacks: { onOutput: (text) => collected.push(text) },
    });

    expect(result.text).toBe('Hello world');
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 17 });
    expect(collected.join('')).toBe('Hello world');

    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0]!.model).toBe('test-model');
    expect(receivedBodies[0]!.stream).toBe(true);
    expect(receivedBodies[0]!.messages[0]).toMatchObject({ role: 'user', content: 'the prompt' });
  });

  it.each([['custom-endpoint'], ['ollama']] as const)(
    'planner.contextLength drives the derived max_tokens for the %s api kind',
    async (provider) => {
      const cfg = makeApiPlannerConfig(provider);
      cfg.planner.contextLength = 5000;
      const planner = createApiPlanner(cfg);

      await planner.regenerate({
        prompt: 'the prompt',
        projectDir,
        callbacks: { onOutput: () => {} },
      });

      expect(receivedBodies).toHaveLength(1);
      const body = receivedBodies[0] as unknown as { max_tokens?: number };
      // contextLength 5000 minus the tiny prompt stays under the 8192 output cap,
      // so the budget tracks the configured window rather than a hard-coded default.
      expect(body.max_tokens).toBeLessThan(5000);
      expect(body.max_tokens!).toBeGreaterThan(4096);
    },
  );

  it('strips effort for a model that does not support reasoning', async () => {
    const cfg = makeApiPlannerConfig('custom-endpoint');
    cfg.planner.effort = 'high';
    const planner = createApiPlanner(cfg);

    await planner.regenerate({
      prompt: 'the prompt',
      projectDir,
      callbacks: { onOutput: () => {} },
    });

    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0]).not.toHaveProperty('reasoning_effort');
  });

  it('plan() runs four phases and accumulates token usage across them', async () => {
    const planner = createApiPlanner(makeApiPlannerConfig('ollama'));
    openAiCompletionChunks = [validPlannerArtifact];

    const result = await planner.plan({
      feature: 'test feature',
      projectDir,
      callbacks: {
        onOutput: vi.fn(),
        onPhase: vi.fn(),
      },
    });

    expect(receivedBodies).toHaveLength(4);
    expect(result.usage).toEqual({ inputTokens: 42 * 4, outputTokens: 17 * 4 });
  });

  it('plan() injects priorMessages into the first phase chat history (FR-007 api-kind)', async () => {
    const planner = createApiPlanner(makeApiPlannerConfig('ollama'));
    openAiCompletionChunks = [validPlannerArtifact];

    await planner.plan({
      feature: 'add auth',
      projectDir,
      callbacks: {
        onOutput: vi.fn(),
        onPhase: vi.fn(),
        priorMessages: [
          { role: 'user', content: 'start: add auth' },
          { role: 'assistant', content: 'we should use JWT' },
        ],
      },
    });

    expect(receivedBodies.length).toBeGreaterThan(0);
    const firstCall = receivedBodies[0]!;
    expect(firstCall.messages[0]).toEqual({ role: 'user', content: 'start: add auth' });
    expect(firstCall.messages[1]).toEqual({ role: 'assistant', content: 'we should use JWT' });
    expect(firstCall.messages[firstCall.messages.length - 1]!.role).toBe('user');

    const secondCall = receivedBodies[1]!;
    expect(secondCall.messages[0]!.role).toBe('user');
    const hasAssistantPrior = secondCall.messages.some(
      (m: { role: string; content: string }) =>
        m.role === 'assistant' && m.content === 'we should use JWT',
    );
    expect(hasAssistantPrior).toBe(false);
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
      planner.regenerate({
        prompt: 'this prompt cannot fit the one-token planner window',
        projectDir,
        callbacks: { onOutput: () => {} },
      }),
    ).rejects.toMatchObject({
      kind: 'provider-prompt-exceeds-context',
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
