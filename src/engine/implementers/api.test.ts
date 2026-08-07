import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
import { createApiImplementer } from './api.js';
import { DEFAULT_IMPLEMENTER_TEMPERATURE } from '../../core/schemas/runner-fields.js';

const temperatureCapableImplementer = {
  provider: 'deepseek',
  apiBase: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test-key',
  model: 'deepseek-chat',
} as const;

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
  it('reports the default local implementer unavailable when the endpoint refuses the connection, after contacting the model list', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const implementer = createApiImplementer(makeConfig());

    expect(await implementer.isAvailable()).toBe(false);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('/api/tags');
  });

  it('reports the default local implementer available when the endpoint returns a non-empty model list', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const implementer = createApiImplementer(makeConfig());

    expect(await implementer.isAvailable()).toBe(true);
  });

  it('re-probes the endpoint on the next availability gate instead of latching the verdict', async () => {
    // The per-task implementer is constructed at task/loop.ts:176
    // (createTaskImplementer); the gate calls isAvailable() once per task
    // iteration, so an implementer unavailable for task N must be probed
    // afresh for task N+1.
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const implementer = createApiImplementer(makeConfig());

    expect(await implementer.isAvailable()).toBe(false);

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(await implementer.isAvailable()).toBe(true);
  });

  it('states why the last availability check failed for an unreachable local endpoint', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const implementer = createApiImplementer(makeConfig());

    await implementer.isAvailable();
    expect(implementer.unavailabilityReason?.()).toBe('fetch failed');

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await implementer.isAvailable();
    expect(implementer.unavailabilityReason?.()).toBe('the endpoint is unreachable');
  });

  it('reports unavailable when a referenced remote API key is missing', async () => {
    const original = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    try {
      const cfg = makeConfig({
        implementer: {
          provider: 'openrouter',
          apiBase: 'https://openrouter.ai/api/v1',
          apiKey: 'env:OPENROUTER_API_KEY',
          model: 'openrouter/test',
        },
      });
      const implementer = createApiImplementer(cfg);

      expect(await implementer.isAvailable()).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = original;
    }
  });

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

  it('aborts an in-flight API call without writing the task file', async () => {
    fetchMock.mockImplementation((_input: unknown, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason ?? new Error('Aborted'));
          },
          { once: true },
        );
      });
    });

    const controller = new AbortController();
    const implementer = createApiImplementer(makeConfig());
    const task = makeTask({ id: 'T010', file: 'src/signal.ts', action: 'create' });
    const pending = implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      signal: controller.signal,
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    controller.abort();
    const result = await pending;

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeTruthy();
    expect(existsSync(join(projectDir, 'src/signal.ts'))).toBe(false);
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

  it('unset implementer temperature sends DEFAULT_IMPLEMENTER_TEMPERATURE', async () => {
    const code = '```ts\nexport const x = 1;\n```';
    fetchMock.mockResolvedValue(makeOpenAiSseResponse([{ content: code }]));

    const cfg = makeConfig({
      implementer: { ...temperatureCapableImplementer, temperature: undefined },
    });
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T016', file: 'src/temperature.ts', action: 'create' });

    await implementer.implement({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    const init = fetchMock.mock.calls.at(-1)?.[1] as { body?: string } | undefined;
    const body = JSON.parse(String(init?.body)) as { temperature?: number };
    expect(body.temperature).toBe(DEFAULT_IMPLEMENTER_TEMPERATURE);
  });

  it('retry() adjusts temperature by retry kind (local bumps, hint unchanged)', async () => {
    const code = '```ts\nexport const x = 1;\n```';
    fetchMock.mockResolvedValue(
      makeOpenAiSseResponse([
        { content: code },
        { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ]),
    );

    const cfg = makeConfig({
      implementer: { ...temperatureCapableImplementer, temperature: 0.2 },
    });
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T005', file: 'src/retry.ts', action: 'create' });
    const baseRetry = {
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
      error: 'previous failure',
      attempt: 2,
    };

    const localResult = await implementer.retry({ ...baseRetry, kind: 'local' });
    expect(localResult.success).toBe(true);
    const localBody = JSON.parse(
      String((fetchMock.mock.calls.at(-1)?.[1] as { body?: string } | undefined)?.body),
    ) as { temperature?: number };
    expect(localBody.temperature).toBe(0.4);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(
      makeOpenAiSseResponse([
        { content: code },
        { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ]),
    );

    const hintResult = await implementer.retry({ ...baseRetry, kind: 'hint' });
    expect(hintResult.success).toBe(true);
    const hintBody = JSON.parse(
      String((fetchMock.mock.calls.at(-1)?.[1] as { body?: string } | undefined)?.body),
    ) as { temperature?: number };
    expect(hintBody.temperature).toBe(0.2);
  });

  // The schema rejects this config at load (a custom provider has no catalog
  // default for `auto` to resolve to). The runtime guard is the backstop for
  // programmatically-built configs that never passed through the schema, so the
  // sentinel is assigned after parsing.
  it('returns failure when model is "auto" for an unknown provider', async () => {
    const cfg = makeConfig({
      implementer: {
        model: 'placeholder-model',
        provider: 'custom-unknown-provider' as never,
        apiBase: 'http://localhost:9999',
        apiKey: 'x',
      },
    });
    cfg.implementer.model = 'auto';
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

  async function capturedMaxTokens(contextLength: number): Promise<number> {
    const code = '```ts\nexport const x = 1;\n```';
    fetchMock.mockResolvedValue(makeOpenAiSseResponse([{ content: code }]));

    const cfg = makeConfig({ implementer: { contextLength } });
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T007', file: 'src/clamp.ts', action: 'create' });

    await implementer.implement({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    const init = fetchMock.mock.calls.at(0)?.[1] as { body?: string } | undefined;
    const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
    expect(typeof body.max_tokens).toBe('number');
    return body.max_tokens as number;
  }

  it('clamps max_tokens to the conservative output cap for a window-sized contextLength', async () => {
    // A 1M context window must not become a 1M max_tokens — that 400s. The output
    // budget is clamped to the conservative per-model cap regardless of window size.
    const maxTokens = await capturedMaxTokens(1_000_000);
    expect(maxTokens).toBeLessThanOrEqual(8192);
  });

  it('budgets the prompt against the shared default when no contextLength is declared', async () => {
    const code = '```ts\nexport const x = 1;\n```';
    fetchMock.mockResolvedValue(makeOpenAiSseResponse([{ content: code }]));

    const cfg = makeConfig({
      implementer: { ...temperatureCapableImplementer, contextLength: undefined },
    });
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T018', file: 'src/shared-default.ts', action: 'create' });

    await implementer.implement({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    const init = fetchMock.mock.calls.at(-1)?.[1] as { body?: string } | undefined;
    const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
    // 32768 minus a small prompt still exceeds the conservative output cap, so the
    // request lands exactly on it; an 8192 window would clamp below it.
    expect(body.max_tokens).toBe(8192);
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

      const fetchInput = fetchMock.mock.calls.at(0)?.[0];
      const fetchInit = fetchMock.mock.calls.at(0)?.[1];
      const request = new Request(fetchInput, fetchInit);
      expect(request.headers.get('Authorization')).toBe('Bearer sk-or-env-key');
      expect(result.success).toBe(true);
    } finally {
      if (origOr === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = origOr;
    }
  });
});
