import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createApiImplementer } from './api.js';

function makeAnthropicSseResponse(
  text: string,
  usage: { input_tokens: number; output_tokens: number },
): Response {
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: usage.output_tokens } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];
  return new Response(events.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

let projectDir: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  projectDir = createTempDir('api-impl-test');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanupTempDir(projectDir);
  vi.unstubAllGlobals();
});

describe('api implementer — Anthropic path', () => {
  it('uses the Anthropic streaming path (direct fetch, x-api-key header)', async () => {
    const code = '```ts\nexport const answer = 42;\n```';
    fetchMock.mockResolvedValue(
      makeAnthropicSseResponse(code, { input_tokens: 88, output_tokens: 44 }),
    );

    const cfg = makeConfig({
      implementer: {
        provider: 'anthropic',
        apiBase: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-test-key',
        model: 'claude-sonnet-4-6',
      },
    });
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T011', file: 'src/anthropic.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.usage).toEqual({ inputTokens: 88, outputTokens: 44 });
  });

  it('forwards the abort signal to the Anthropic fetch call', async () => {
    const code = '```ts\nexport const x = 1;\n```';
    fetchMock.mockResolvedValue(
      makeAnthropicSseResponse(code, { input_tokens: 1, output_tokens: 1 }),
    );

    const cfg = makeConfig({
      implementer: {
        provider: 'anthropic',
        apiBase: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-test-key',
        model: 'claude-sonnet-4-6',
      },
    });
    const controller = new AbortController();
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T012', file: 'src/ant-signal.ts', action: 'create' });

    await implementer.implement({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
      signal: controller.signal,
    });

    const init = fetchMock.mock.calls.at(0)?.[1] as { signal?: unknown } | undefined;
    expect(init?.signal).toBe(controller.signal);
  });

  it('picks up ANTHROPIC_API_KEY from env when no apiKey is configured', async () => {
    const code = '```ts\nexport const x = 1;\n```';
    fetchMock.mockResolvedValue(
      makeAnthropicSseResponse(code, { input_tokens: 1, output_tokens: 1 }),
    );

    const orig = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env-key';
    try {
      const cfg = makeConfig({
        implementer: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          apiBase: 'https://api.anthropic.com/v1',
        },
      });
      const implementer = createApiImplementer(cfg);
      const task = makeTask({ id: 'T013', file: 'src/ant.ts', action: 'create' });

      const result = await implementer.implement({
        task,
        projectDir,
        config: cfg,
        context: defaultContext,
        onOutput: vi.fn(),
      });

      const fetchInput = fetchMock.mock.calls.at(0)?.[0];
      const fetchInit = fetchMock.mock.calls.at(0)?.[1];
      const request = new Request(fetchInput, fetchInit);
      expect(request.headers.get('x-api-key')).toBe('sk-ant-env-key');
      expect(result.success).toBe(true);
    } finally {
      if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });

  it('forwards configured effort to the Anthropic request body as a thinking budget', async () => {
    const code = '```ts\nexport const x = 1;\n```';
    fetchMock.mockResolvedValue(
      makeAnthropicSseResponse(code, { input_tokens: 1, output_tokens: 1 }),
    );

    const cfg = makeConfig({
      implementer: {
        provider: 'anthropic',
        apiBase: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-test-key',
        model: 'claude-sonnet-4-6',
        effort: 'high',
      },
    });
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T015', file: 'src/effort.ts', action: 'create' });

    await implementer.implement({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    const init = fetchMock.mock.calls.at(0)?.[1] as { body?: string } | undefined;
    const body = JSON.parse(String(init?.body)) as {
      thinking?: { type?: string; budget_tokens?: number };
    };
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 24_000 });
  });

  it('aborts a stalled stream once the configured timeout elapses', async () => {
    // A stream that connects but never yields a chunk must not hang forever: the
    // configured timeout aborts the in-flight fetch and the call fails.
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (!signal) return;
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      );
    });

    const cfg = makeConfig({
      implementer: {
        provider: 'anthropic',
        apiBase: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-test-key',
        model: 'claude-sonnet-4-6',
        timeout: 50,
      },
    });
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T016', file: 'src/stall.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(existsSync(join(projectDir, 'src/stall.ts'))).toBe(false);
  }, 10_000);

  it('refuses env-sourced Anthropic key with a custom apiBase', async () => {
    const orig = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env-key';
    try {
      const cfg = makeConfig({
        implementer: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          apiBase: 'https://proxy.example.com/v1',
        },
      });
      const implementer = createApiImplementer(cfg);
      const task = makeTask({ id: 'T014', file: 'src/guard.ts', action: 'create' });

      const result = await implementer.implement({
        task,
        projectDir,
        config: cfg,
        context: defaultContext,
        onOutput: vi.fn(),
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/endpoint policy|exfiltrat/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });
});
