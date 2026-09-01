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

  it('gives up on an endpoint that never answers and reports not-probed', async () => {
    const port = await listen(() => {
      // Accepts the connection and never responds.
    });

    const started = Date.now();
    const facts = await probeRunnerAvailability({ config: ollamaConfig(port) });
    const elapsed = Date.now() - started;

    expect(facts[0]?.verdict).toMatchObject({ state: 'not-probed' });
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

  it('skips runner kinds that have no endpoint to probe', async () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'shell', command: '/bin/cat', model: 'local' },
    });

    expect(await probeRunnerAvailability({ config })).toEqual([]);
  });
});
