import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  probeRunnerAvailability,
  RUNNER_AVAILABILITY_PROBE_TIMEOUT_MS,
} from './probe-availability.js';

const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function ollamaConfig(port: number) {
  return makeConfig({
    planner: { kind: 'cli', tool: 'claude-code' },
    implementer: {
      kind: 'api',
      provider: 'ollama',
      model: 'qwen3-coder:30b',
      apiBase: `http://127.0.0.1:${port}/v1`,
    },
  });
}

describe('probeRunnerAvailability', () => {
  it('reports an unreachable local daemon as unavailable with its diagnostic', async () => {
    const port = await closedPort();

    const facts = await probeRunnerAvailability({ config: ollamaConfig(port) });

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      slot: { role: 'implementer', profile: 'default' },
      provider: 'ollama',
      endpoint: `http://127.0.0.1:${port}/v1`,
      verdict: { state: 'unavailable' },
    });
  });

  it('reports a listening daemon with models as available', async () => {
    const port = await listen((request, response) => {
      if (request.url === '/api/tags') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [{ name: 'qwen3-coder:30b' }] }));
        return;
      }
      response.writeHead(404).end();
    });

    const facts = await probeRunnerAvailability({ config: ollamaConfig(port) });

    expect(facts[0]?.verdict).toEqual({ state: 'available' });
  });

  it('does not call an empty catalog available', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [] }));
    });

    const facts = await probeRunnerAvailability({ config: ollamaConfig(port) });

    expect(facts[0]?.verdict).toEqual({ state: 'no-models' });
  });

  it('gives up on an endpoint that never answers and reports a timeout', async () => {
    const port = await listen(() => {
      // Accepts the connection and never responds.
    });

    const started = Date.now();
    const facts = await probeRunnerAvailability({ config: ollamaConfig(port) });
    const elapsed = Date.now() - started;

    expect(facts[0]?.verdict).toMatchObject({ state: 'timeout' });
    expect(elapsed).toBeLessThan(RUNNER_AVAILABILITY_PROBE_TIMEOUT_MS * 2);
  });

  it('reports a custom provider with no credential as not-probed without contacting it', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        model: 'some-model',
        apiBase: 'https://example.com/v1',
      },
    });

    const facts = await probeRunnerAvailability({ config });

    expect(facts[0]).toMatchObject({
      provider: 'custom-endpoint',
      verdict: { state: 'not-probed' },
    });
  });

  it('probes only the planner when the implementer role is out of scope', async () => {
    const port = await closedPort();

    const facts = await probeRunnerAvailability({
      config: ollamaConfig(port),
      roles: ['planner'],
    });

    expect(facts).toEqual([]);
  });

  it('probes a configured api reviewer and leaves a cli reviewer alone', async () => {
    const port = await closedPort();
    const apiReviewer = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'cli', tool: 'claude-code' },
      reviewer: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        model: 'some-model',
        apiBase: `http://127.0.0.1:${port}/v1`,
        apiKey: 'test-key',
      },
    });
    const cliReviewer = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'cli', tool: 'claude-code' },
      reviewer: { kind: 'cli', tool: 'claude-code' },
    });

    await expect(probeRunnerAvailability({ config: apiReviewer })).resolves.toMatchObject([
      {
        slot: { role: 'reviewer' },
        provider: 'custom-endpoint',
        verdict: { state: 'unavailable' },
      },
    ]);
    await expect(probeRunnerAvailability({ config: cliReviewer })).resolves.toEqual([]);
  });

  it('leaves the reviewer seat unprobed when no reviewer is configured', async () => {
    const port = await closedPort();

    const facts = await probeRunnerAvailability({ config: ollamaConfig(port) });

    expect(facts.map((fact) => fact.slot.role)).toEqual(['implementer']);
  });

  it('never passes an unrelated sole model off as the selected one', async () => {
    const port = await listen((request, response) => {
      if (request.url === '/api/tags') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [{ name: 'llama3:8b' }] }));
        return;
      }
      response.writeHead(404).end();
    });

    const facts = await probeRunnerAvailability({ config: ollamaConfig(port) });

    expect(facts[0]?.verdict).toEqual({ state: 'missing-model', selectionId: 'qwen3-coder:30b' });
  });

  it('admits a listed model the daemon has not loaded, without asking it to load', async () => {
    const urls: string[] = [];
    const port = await listen((request, response) => {
      urls.push(request.url ?? '');
      if (request.url === '/api/tags') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [{ name: 'qwen3-coder:30b' }] }));
        return;
      }
      if (request.url === '/api/ps') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [] }));
        return;
      }
      response.writeHead(404).end();
    });

    const facts = await probeRunnerAvailability({ config: ollamaConfig(port) });

    expect(facts[0]?.verdict).toEqual({ state: 'available' });
    expect(urls).toEqual(['/api/tags', '/api/ps']);
    for (const url of urls) {
      expect(url).not.toMatch(/generate|chat|completions|embed|pull|create|load|unload|delete/);
    }
  });

  it('reports a rejected credential as unauthorized rather than unreachable', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(401).end();
    });
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: {
        kind: 'api',
        provider: 'lm-studio',
        model: 'qwen/qwen3-coder-30b',
        apiBase: `http://127.0.0.1:${port}/v1`,
        apiKey: 'lm-studio-test-key',
      },
    });

    const facts = await probeRunnerAvailability({ config });

    expect(facts[0]?.verdict).toMatchObject({ state: 'unauthorized', diagnostic: 'HTTP 401' });
  });

  it('gives every seat its own endpoint and its own selected model', async () => {
    const plannerPort = await listen((request, response) => {
      if (request.url === '/api/tags') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [{ name: 'plan-model:8b' }] }));
        return;
      }
      response.writeHead(404).end();
    });
    const reviewerPort = await listen((request, response) => {
      if (request.url === '/api/tags') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [{ name: 'plan-model:8b' }] }));
        return;
      }
      response.writeHead(404).end();
    });
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'ollama',
        model: 'plan-model:8b',
        apiBase: `http://127.0.0.1:${plannerPort}/v1`,
      },
      implementer: { kind: 'cli', tool: 'claude-code' },
      reviewer: {
        kind: 'api',
        provider: 'ollama',
        model: 'review-model:8b',
        apiBase: `http://127.0.0.1:${reviewerPort}/v1`,
      },
    });

    const facts = await probeRunnerAvailability({ config });

    // The reviewer asks its own endpoint for its own model and is not admitted
    // by the planner's catalog, which happens to serve the planner's model.
    expect(facts).toMatchObject([
      { slot: { role: 'planner' }, verdict: { state: 'available' } },
      {
        slot: { role: 'reviewer' },
        endpoint: `http://127.0.0.1:${reviewerPort}/v1`,
        verdict: { state: 'missing-model', selectionId: 'review-model:8b' },
      },
    ]);
  });

  it('skips runner kinds that have no endpoint to probe', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'shell', command: '/bin/cat', model: 'local' },
    });

    expect(await probeRunnerAvailability({ config })).toEqual([]);
  });
});

describe('probeRunnerAvailability in-flight sharing', () => {
  // `/api/ps` is the read-only load observation that rides along with a catalog
  // read; the count is of catalog round trips, which is what sharing collapses.
  async function countingEndpoint(): Promise<Readonly<{ port: number; requests: () => number }>> {
    let requests = 0;
    const port = await listen((request, response) => {
      if (request.url === '/api/ps') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [] }));
        return;
      }
      requests += 1;
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [{ name: 'qwen3-coder:30b' }] }));
      }, 20);
    });
    return { port, requests: () => requests };
  }

  function seatConfig(input: Readonly<{ port: number; model?: string | undefined }>) {
    return makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: input.model ?? 'qwen3-coder:30b',
        apiBase: `http://127.0.0.1:${input.port}/v1`,
      },
    });
  }

  it('serves two identical concurrent probes from one round trip', async () => {
    const endpoint = await countingEndpoint();
    const config = seatConfig({ port: endpoint.port });

    const [first, second] = await Promise.all([
      probeRunnerAvailability({ config }),
      probeRunnerAvailability({ config }),
    ]);

    expect(first[0]?.verdict).toEqual({ state: 'available' });
    expect(second[0]?.verdict).toEqual({ state: 'available' });
    expect(endpoint.requests()).toBe(1);
  });

  it('probes separately when the selected model differs', async () => {
    const endpoint = await countingEndpoint();

    await Promise.all([
      probeRunnerAvailability({ config: seatConfig({ port: endpoint.port }) }),
      probeRunnerAvailability({
        config: seatConfig({ port: endpoint.port, model: 'qwen3-coder:7b' }),
      }),
    ]);

    expect(endpoint.requests()).toBe(2);
  });

  it('probes separately when a second profile asks the same endpoint', async () => {
    const endpoint = await countingEndpoint();
    const api = {
      kind: 'api' as const,
      provider: 'ollama',
      model: 'qwen3-coder:30b',
      apiBase: `http://127.0.0.1:${endpoint.port}/v1`,
    };
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      implementerProfiles: { default: 'fast', profiles: { fast: api, careful: api } },
    });

    const facts = await probeRunnerAvailability({ config });

    expect(facts.map((fact) => fact.slot)).toEqual([
      { role: 'implementer', profile: 'careful' },
      { role: 'implementer', profile: 'fast' },
    ]);
    expect(endpoint.requests()).toBe(2);
  });

  it('probes afresh once the shared probe has settled', async () => {
    const endpoint = await countingEndpoint();
    const config = seatConfig({ port: endpoint.port });

    await probeRunnerAvailability({ config });
    await probeRunnerAvailability({ config });

    expect(endpoint.requests()).toBe(2);
  });

  function credentialConfig(input: Readonly<{ port: number; apiKey: string }>) {
    return makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        model: 'some-model',
        apiBase: `http://127.0.0.1:${input.port}/v1`,
        apiKey: input.apiKey,
      },
    });
  }

  it('never shares an endpoint whose credential is an inline key', async () => {
    const endpoint = await countingEndpoint();
    const config = credentialConfig({ port: endpoint.port, apiKey: 'inline-test-key' });

    await Promise.all([probeRunnerAvailability({ config }), probeRunnerAvailability({ config })]);

    expect(endpoint.requests()).toBe(2);
  });

  it('separates two endpoints that differ only in their auth identity', async () => {
    const endpoint = await countingEndpoint();
    process.env.OLLAMA_LOCAL_API_KEY = 'local-value';
    try {
      const withEnvRef = makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: {
          kind: 'api',
          provider: 'ollama',
          model: 'qwen3-coder:30b',
          apiBase: `http://127.0.0.1:${endpoint.port}/v1`,
          apiKey: 'env:OLLAMA_LOCAL_API_KEY',
        },
      });

      await Promise.all([
        probeRunnerAvailability({ config: withEnvRef }),
        probeRunnerAvailability({ config: withEnvRef }),
      ]);
      expect(endpoint.requests()).toBe(1);

      await Promise.all([
        probeRunnerAvailability({ config: withEnvRef }),
        probeRunnerAvailability({ config: seatConfig({ port: endpoint.port }) }),
      ]);
      expect(endpoint.requests()).toBe(3);
    } finally {
      delete process.env.OLLAMA_LOCAL_API_KEY;
    }
  });

  it('reports a caller that stopped waiting as not-probed and leaves the other served', async () => {
    const endpoint = await countingEndpoint();
    const config = seatConfig({ port: endpoint.port });
    const leaving = new AbortController();

    const cancelled = probeRunnerAvailability({ config, signal: leaving.signal });
    const staying = probeRunnerAvailability({ config, signal: new AbortController().signal });
    leaving.abort();

    expect((await cancelled)[0]?.verdict).toMatchObject({ state: 'not-probed' });
    expect((await staying)[0]?.verdict).toEqual({ state: 'available' });
    expect(endpoint.requests()).toBe(1);
  });
});
