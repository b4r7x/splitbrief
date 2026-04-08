import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../../types.js';
import { createApiPlanner } from './api.js';

let server: http.Server;
let port: number;
let receivedBodies: any[];
let projectDir: string;

function makeConfig(provider: string, overrides?: Partial<Config['planner']>): Config {
  return {
    planner: {
      tool: 'claude-code',
      provider,
      model: 'test-model',
      apiBase: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test-key',
      ...overrides,
    },
    implementer: {
      provider: 'ollama',
      model: 'test',
      apiBase: '',
      contextLength: 8192,
      temperature: 0.3,
    },
    validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
    workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none' },
  };
}

function streamSseChunks(res: http.ServerResponse, chunks: string[], finalUsage?: { prompt_tokens: number; completion_tokens: number }) {
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
  projectDir = mkdtempSync(join(tmpdir(), 'api-planner-test-'));

  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        streamSseChunks(res, ['Hello ', 'world'], { prompt_tokens: 42, completion_tokens: 17 });
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  if (server.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(projectDir, { recursive: true, force: true });
});

describe('createApiPlanner', () => {
  it('regenerate sends prompt to chat endpoint and returns parsed text + usage', async () => {
    const planner = createApiPlanner(makeConfig('ollama'));
    const collected: string[] = [];

    const result = await planner.regenerate('the prompt', 'spec', projectDir, {
      onOutput: (text) => collected.push(text),
    });

    expect(result.text).toBe('Hello world');
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 17 });
    expect(collected.join('')).toBe('Hello world');

    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0].model).toBe('test-model');
    expect(receivedBodies[0].stream).toBe(true);
    expect(receivedBodies[0].messages[0]).toMatchObject({ role: 'user', content: 'the prompt' });
  });

  it('plan() runs four phases and accumulates token usage across them', async () => {
    const planner = createApiPlanner(makeConfig('ollama'));

    const result = await planner.plan('test feature', projectDir, makeConfig('ollama'), {
      onOutput: vi.fn(),
      onPhase: vi.fn(),
    });

    expect(receivedBodies).toHaveLength(4);
    expect(result.usage).toEqual({ inputTokens: 42 * 4, outputTokens: 17 * 4 });
  });

  it('isAvailable returns true when models endpoint responds', async () => {
    const planner = createApiPlanner(makeConfig('ollama'));
    expect(await planner.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when endpoint is unreachable', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const planner = createApiPlanner(makeConfig('ollama'));
    expect(await planner.isAvailable()).toBe(false);
  });

});
