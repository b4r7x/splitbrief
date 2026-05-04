import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../../core/schemas/config.js';
import { createApiPlanner } from './api.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let server: http.Server;
let port: number;
type RequestBody = { model: string; stream: boolean; messages: { role: string; content: string }[] };
let receivedBodies: RequestBody[];
let receivedHeaders: http.IncomingHttpHeaders[];
let projectDir: string;

function makeApiPlannerConfig(provider: string): Config {
  return {
    version: 2,
    planner: {
      kind: 'api',
      provider,
      model: 'test-model',
      apiBase: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test-key',
    },
    implementer: {
      kind: 'api',
      provider: 'ollama',
      model: 'test',
      apiBase: 'http://localhost:11434/v1',
      contextLength: 8192,
      temperature: 0.3,
    },
    validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' },
    workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitStrategy: 'none', persistTranscript: true, compactionFormat: 'auto' },
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

function streamAnthropicChunks(
  res: http.ServerResponse,
  chunks: string[],
  usage: { input_tokens: number; output_tokens: number },
) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } })}\n\n`);
  for (const text of chunks) {
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`);
  }
  res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: usage.output_tokens } })}\n\n`);
  res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  res.end();
}

beforeEach(async () => {
  receivedBodies = [];
  receivedHeaders = [];
  projectDir = createTempDir('api-planner-test');

  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
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
        streamSseChunks(res, ['Hello ', 'world'], { prompt_tokens: 42, completion_tokens: 17 });
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/messages') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        receivedHeaders.push(req.headers);
        streamAnthropicChunks(res, ['Hello ', 'Claude'], { input_tokens: 42, output_tokens: 17 });
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
  cleanupTempDir(projectDir);
});

describe('createApiPlanner', () => {
  it('regenerate sends prompt to chat endpoint and returns parsed text + usage', async () => {
    const planner = createApiPlanner(makeApiPlannerConfig('ollama'));
    const collected: string[] = [];

    const result = await planner.regenerate('the prompt', 'spec', projectDir, {
      onOutput: (text) => collected.push(text),
    });

    expect(result.text).toBe('Hello world');
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 17 });
    expect(collected.join('')).toBe('Hello world');

    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0]!.model).toBe('test-model');
    expect(receivedBodies[0]!.stream).toBe(true);
    expect(receivedBodies[0]!.messages[0]).toMatchObject({ role: 'user', content: 'the prompt' });
  });

  it('uses Anthropic messages API for Anthropic planner selections', async () => {
    const planner = createApiPlanner(makeApiPlannerConfig('anthropic'));
    const collected: string[] = [];

    const result = await planner.regenerate('the prompt', 'spec', projectDir, {
      onOutput: (text) => collected.push(text),
    });

    expect(result.text).toBe('Hello Claude');
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 17 });
    expect(collected.join('')).toBe('Hello Claude');

    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0]).toMatchObject({
      model: 'test-model',
      stream: true,
      messages: [{ role: 'user', content: 'the prompt' }],
    });
    expect(receivedHeaders[0]).toMatchObject({
      'anthropic-version': '2023-06-01',
      'x-api-key': 'test-key',
    });
  });

  it('plan() runs four phases and accumulates token usage across them', async () => {
    const planner = createApiPlanner(makeApiPlannerConfig('ollama'));

    const result = await planner.plan('test feature', projectDir, {
      onOutput: vi.fn(),
      onPhase: vi.fn(),
    });

    expect(receivedBodies).toHaveLength(4);
    expect(result.usage).toEqual({ inputTokens: 42 * 4, outputTokens: 17 * 4 });
  });

  it('plan() injects priorMessages into the first phase chat history (FR-007 api-kind)', async () => {
    const planner = createApiPlanner(makeApiPlannerConfig('ollama'));

    await planner.plan('add auth', projectDir, {
      onOutput: vi.fn(),
      onPhase: vi.fn(),
      priorMessages: [
        { role: 'user', content: 'start: add auth' },
        { role: 'assistant', content: 'we should use JWT' },
      ],
    });

    expect(receivedBodies.length).toBeGreaterThan(0);
    const firstCall = receivedBodies[0]!;
    // First two messages = prior history; the current prompt is appended last.
    expect(firstCall.messages[0]).toEqual({ role: 'user', content: 'start: add auth' });
    expect(firstCall.messages[1]).toEqual({ role: 'assistant', content: 'we should use JWT' });
    expect(firstCall.messages[firstCall.messages.length - 1]!.role).toBe('user');

    // Subsequent phases do NOT repeat priorMessages.
    const secondCall = receivedBodies[1]!;
    expect(secondCall.messages[0]!.role).toBe('user');
    // Prior assistant turn should not be present in phase 2+
    const hasAssistantPrior = secondCall.messages.some((m: { role: string; content: string }) => m.role === 'assistant' && m.content === 'we should use JWT');
    expect(hasAssistantPrior).toBe(false);
  });

  it.each([['ollama'], ['anthropic']] as const)('isAvailable returns true for %s when endpoint responds', async (provider) => {
    const planner = createApiPlanner(makeApiPlannerConfig(provider));
    expect(await planner.isAvailable()).toBe(true);
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

});
