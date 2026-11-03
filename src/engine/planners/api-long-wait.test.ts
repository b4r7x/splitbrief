import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../core/schemas/config.js';
import { callPlanner } from '#testing/helpers/planner-call.js';
import { passFetchLimit, shortenFetchLimits } from '#testing/helpers/fetch-idle-limits.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createApiPlanner } from './api.js';

type Pause = 'headers' | 'body';

let server: http.Server;
let base: string;
let projectDir: string;
let completionRequests: number;
let paused: Promise<void>;
let release: () => void;
let pause: Pause;

function sseEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function textChunk(text: string): string {
  return sseEvent({ choices: [{ delta: { content: text }, index: 0, finish_reason: null }] });
}

function plannerConfig(): Config {
  return {
    version: 3,
    planner: {
      kind: 'api',
      provider: 'custom-endpoint',
      service: 'custom-endpoint',
      offering: 'payg',
      model: 'test-model',
      apiBase: `${base}/v1`,
      apiKey: 'test-key',
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
    validation: { endChecks: true, testCommand: 'npm test' },
    workflow: { compactionFormat: 'auto' },
  };
}

shortenFetchLimits();

beforeEach(async () => {
  projectDir = createTempDir('api-planner-long-wait');
  completionRequests = 0;
  let pauseStarted!: () => void;
  paused = new Promise<void>((resolve) => {
    pauseStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      completionRequests += 1;
      request.resume();
      const answer = (): void => {
        if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(textChunk('the plan'));
        response.write(
          sseEvent({
            choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
        );
        response.end('data: [DONE]\n\n');
      };
      if (pause === 'body') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(textChunk('thinking, '), () => pauseStarted());
      } else {
        pauseStarted();
      }
      void released.then(answer);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupTempDir(projectDir);
});

describe('an api planner seat with no timeout', () => {
  it.each([
    ['for the first answer bytes past the header limit', 'headers'],
    ['through a pause in the answer stream past the body limit', 'body'],
  ] as const)('keeps waiting %s', async (_case, kind) => {
    pause = kind;
    const planner = createApiPlanner(plannerConfig());

    const outcome = callPlanner(planner, { projectDir, callbacks: { onOutput: () => {} } }).then(
      (result) => ({ text: result.text }),
      (cause: unknown) => ({ error: cause instanceof Error ? cause.message : String(cause) }),
    );
    await paused;
    await passFetchLimit(kind);
    release();

    expect(await outcome).toEqual({
      text: kind === 'body' ? 'thinking, the plan' : 'the plan',
    });
    expect(completionRequests).toBe(1);
  });
});
