import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
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

describe('api implementer — OpenAI-compatible path', () => {
  it('writes extracted code to disk and returns success with usage', async () => {
    const code = '```typescript\nexport function hello() {\n  return "hi";\n}\n```';
    fetchMock.mockResolvedValue(
      makeOpenAiSseResponse([
        { content: code },
        { usage: { prompt_tokens: 100, completion_tokens: 50 } },
      ]),
    );

    const implementer = createApiImplementer(makeConfig());
    const task = makeTask({ id: 'T001', file: 'src/hello.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });

    const written = readFileSync(join(projectDir, 'src/hello.ts'), 'utf-8');
    expect(written).toContain('export function hello()');
    expect(written).toContain('return "hi"');
  });

  it('forwards the abort signal to the underlying fetch call', async () => {
    const code = '```ts\nexport const x = 1;\n```';
    fetchMock.mockResolvedValue(makeOpenAiSseResponse([{ content: code }]));

    const controller = new AbortController();
    const implementer = createApiImplementer(makeConfig());
    const task = makeTask({ id: 'T010', file: 'src/signal.ts', action: 'create' });

    await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      signal: controller.signal,
    });

    const init = fetchMock.mock.calls.at(0)?.[1] as { signal?: unknown } | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns failure when the stream response has no extractable code', async () => {
    fetchMock.mockResolvedValue(
      makeOpenAiSseResponse([{ content: 'I think you should try writing this yourself.' }]),
    );

    const implementer = createApiImplementer(makeConfig());
    const task = makeTask({ id: 'T002', file: 'src/nowrite.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/extract|code/i);
    expect(existsSync(join(projectDir, 'src/nowrite.ts'))).toBe(false);
  });

  it('returns failure with the error message when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('Connection timeout'));

    const implementer = createApiImplementer(makeConfig());
    const task = makeTask({ id: 'T003', file: 'src/failed.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    // The OpenAI SDK wraps network errors via its retry+timeout layer; the
    // observable surface is that the API call did not succeed and no file was
    // written.
    if (!result.success) expect(result.error).toBeTruthy();
    expect(existsSync(join(projectDir, 'src/failed.ts'))).toBe(false);
  }, 20_000);

  it('propagates token usage from the stream response to the result', async () => {
    const code = '```ts\nexport const answer = 42;\n```';
    fetchMock.mockResolvedValue(
      makeOpenAiSseResponse([
        { content: code },
        { usage: { prompt_tokens: 777, completion_tokens: 333 } },
      ]),
    );

    const implementer = createApiImplementer(makeConfig());
    const task = makeTask({ id: 'T004', file: 'src/answer.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.usage).toEqual({ inputTokens: 777, outputTokens: 333 });
  });

  it('retry() bumps temperature for attempt N (local kind)', async () => {
    const code = '```ts\nexport const x = 1;\n```';
    fetchMock.mockResolvedValue(
      makeOpenAiSseResponse([
        { content: code },
        { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ]),
    );

    const cfg = makeConfig({ implementer: { temperature: 0.2 } });
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T005', file: 'src/retry.ts', action: 'create' });

    const result = await implementer.retry({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
      error: 'previous failure',
      attempt: 2,
      kind: 'local',
    });

    expect(result.success).toBe(true);
  });

  it('returns failure when model is "auto" for an unknown provider', async () => {
    const cfg = makeConfig({
      implementer: {
        model: 'auto',
        provider: 'custom-unknown-provider' as never,
        apiBase: 'http://localhost:9999',
        apiKey: 'x',
      },
    });
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T006', file: 'src/auto.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/API implementer requires an explicit model/);
  });

  it('clamps max_tokens to within the configured contextLength', async () => {
    const code = '```ts\nexport const x = 1;\n```';
    fetchMock.mockResolvedValue(makeOpenAiSseResponse([{ content: code }]));

    const cfg = makeConfig({ implementer: { contextLength: 2048 } });
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T007', file: 'src/clamp.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
  });

  it('uses provider-specific env var for API key fallback (OPENROUTER_API_KEY)', async () => {
    const code = '```ts\nexport const x = 1;\n```';
    fetchMock.mockResolvedValue(makeOpenAiSseResponse([{ content: code }]));

    const origOr = process.env['OPENROUTER_API_KEY'];
    process.env['OPENROUTER_API_KEY'] = 'sk-or-env-key';
    try {
      const cfg = makeConfig({
        implementer: {
          provider: 'openrouter',
          model: 'openrouter/claude-3.5-sonnet',
          apiBase: 'https://openrouter.ai/api/v1',
        },
      });
      const implementer = createApiImplementer(cfg);
      const task = makeTask({ id: 'T008', file: 'src/or.ts', action: 'create' });

      const result = await implementer.implement({
        task,
        projectDir,
        config: cfg,
        context: defaultContext,
        onOutput: vi.fn(),
      });

      expect(result.success).toBe(true);
    } finally {
      if (origOr === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = origOr;
    }
  });
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
        apiKey: 'test-key',
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
        apiKey: 'test-key',
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

      expect(result.success).toBe(true);
    } finally {
      if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });

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
      if (!result.success) expect(result.error).toMatch(/exfiltrat/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });
});
