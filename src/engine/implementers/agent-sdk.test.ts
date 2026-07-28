import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import type { RunnerCallEvent } from '../calls/types.js';
import type { ImplementerPublisher } from './types.js';
import { createAgentSdkImplementer } from './agent-sdk.js';
import { DEFAULT_AGENT_SDK_MODEL } from '../../core/providers/known-models.js';

/**
 * Agent SDK implementer — exercised against the real wrapper in
 * `src/engine/runners/agent-sdk/backend.ts`. The only sanctioned mock here is the optional
 * peer dep `@anthropic-ai/claude-agent-sdk`, whose `query()` is stubbed to
 * yield a canned stream. Everything else (resolveAutoModel, known-models
 * defaults, change detection via git, apiKey env threading) runs for real.
 */

const queryMock = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: unknown) => queryMock(opts),
}));

async function* asyncIter<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

/** Stream that writes a canned assistant message then a result. */
function setQueryResponse(text: string): void {
  queryMock.mockImplementation(() =>
    asyncIter([
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'assistant', message: { content: [{ type: 'text', text }] } },
      {
        type: 'result',
        result: text,
        session_id: 'sess-1',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]),
  );
}

function makeAgentSdkConfig(overrides?: Record<string, unknown>) {
  return makeConfig({
    implementer: {
      kind: 'agent-sdk' as const,
      model: DEFAULT_AGENT_SDK_MODEL,
      apiKey: undefined,
      ...overrides,
    },
  });
}

let projectDir: string;

beforeEach(() => {
  queryMock.mockReset();
  projectDir = createTempDir('agent-sdk-impl');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createAgentSdkImplementer', () => {
  it('passes implementer tools, acceptEdits permission mode to the SDK query', async () => {
    setQueryResponse('done');
    writeFileSync(join(projectDir, 'init.txt'), 'changed\n');

    const cfg = makeAgentSdkConfig();
    const implementer = createAgentSdkImplementer(cfg);

    await implementer.implement({
      task: makeTask(),
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          permissionMode: 'acceptEdits',
        }),
      }),
    );
  });

  it('passes configured model through to the SDK query call', async () => {
    setQueryResponse('done');
    // Make sure change detection sees a modification
    writeFileSync(join(projectDir, 'init.txt'), 'changed\n');

    const cfg = makeAgentSdkConfig({ model: 'claude-opus-4-6' });
    const implementer = createAgentSdkImplementer(cfg);

    await implementer.implement({
      task: makeTask(),
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ model: 'claude-opus-4-6' }) }),
    );
  });

  it('aborts an in-flight SDK query and leaves the repository unchanged', async () => {
    let sdkAbortController: AbortController | undefined;
    queryMock.mockImplementationOnce(
      (params: { options?: { abortController?: AbortController } }) => {
        sdkAbortController = params.options?.abortController;
        return {
          [Symbol.asyncIterator](): AsyncIterator<unknown> {
            return {
              next: () =>
                new Promise<IteratorResult<unknown>>((_, reject) => {
                  sdkAbortController?.signal.addEventListener(
                    'abort',
                    () => {
                      reject(sdkAbortController?.signal.reason ?? new Error('Aborted'));
                    },
                    { once: true },
                  );
                }),
            };
          },
        };
      },
    );

    const cfg = makeAgentSdkConfig();
    const implementer = createAgentSdkImplementer(cfg);
    const controller = new AbortController();
    const pending = implementer.implement({
      task: makeTask(),
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
      signal: controller.signal,
    });

    await vi.waitFor(() => {
      expect(sdkAbortController).toBeDefined();
    });
    controller.abort(new Error('Aborted'));
    const result = await pending;

    expect(sdkAbortController?.signal.aborted).toBe(true);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Aborted/i);
    expect(existsSync(join(projectDir, 'src'))).toBe(false);
  });

  it('short-circuits without invoking the SDK when the signal is already aborted', async () => {
    setQueryResponse('done');

    const cfg = makeAgentSdkConfig();
    const implementer = createAgentSdkImplementer(cfg);

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
      signal: AbortSignal.abort(),
    });

    expect(queryMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('Aborted');
  });

  it('resolves model "auto" to the agent-sdk default', async () => {
    setQueryResponse('done');
    writeFileSync(join(projectDir, 'init.txt'), 'changed\n');

    const cfg = makeAgentSdkConfig({ model: 'auto' });
    const implementer = createAgentSdkImplementer(cfg);

    await implementer.implement({
      task: makeTask(),
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ model: DEFAULT_AGENT_SDK_MODEL }),
      }),
    );
  });

  it('isAvailable() is true when an API key is configured, false otherwise', async () => {
    const origEnv = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const noKey = createAgentSdkImplementer(makeAgentSdkConfig());
      expect(await noKey.isAvailable!()).toBe(false);

      const withKey = createAgentSdkImplementer(makeAgentSdkConfig({ apiKey: 'sk-test' }));
      // isAvailable tries to load the SDK; since the peer dep is mocked (present), it returns true.
      expect(await withKey.isAvailable!()).toBe(true);
    } finally {
      if (origEnv === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = origEnv;
    }
  });

  it('reports failure via real change detection when the SDK produced no file changes', async () => {
    setQueryResponse('I considered this but did not edit anything.');

    const cfg = makeAgentSdkConfig();
    const implementer = createAgentSdkImplementer(cfg);

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    // The real createChangeDetector sees no new dirty files → reports false.
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Agent SDK.*without changing/);
  });

  it('reports success when the SDK-triggered work leaves new dirty files in the repo', async () => {
    // Simulate the SDK writing a file as part of its stream processing.
    queryMock.mockImplementation((_opts: unknown) => {
      return asyncIter([
        { type: 'system', subtype: 'init', session_id: 'sess-1' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'wrote a file' }] } },
        {
          type: 'result',
          result: 'wrote a file',
          session_id: 'sess-1',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);
    });
    // Create a new, untracked file BEFORE invoke — createAgentSdkBackend will snapshot
    // the dirty list BEFORE the SDK runs, so we need to write the file during the
    // async SDK iteration. Simulate by tweaking the stream iterator:
    queryMock.mockImplementation(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src/new-file.ts'), 'export const x = 1;\n');
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
      yield {
        type: 'result',
        result: 'ok',
        session_id: 'sess-1',
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    });

    const cfg = makeAgentSdkConfig();
    const implementer = createAgentSdkImplementer(cfg);

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('resolves an env:NAME apiKey reference against process.env before injecting it', async () => {
    const origEnv = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    process.env['SPLITBRIEF_TEST_KEY'] = 'sk-resolved-from-env';

    queryMock.mockImplementationOnce(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      writeFileSync(join(projectDir, 'touched.txt'), 'v2\n');
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
      yield {
        type: 'result',
        result: 'ok',
        session_id: 'sess-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });

    try {
      const cfg = makeAgentSdkConfig({ apiKey: 'env:SPLITBRIEF_TEST_KEY' });
      const implementer = createAgentSdkImplementer(cfg);

      await implementer.implement({
        task: makeTask(),
        projectDir,
        config: cfg,
        context: defaultContext,
        onOutput: vi.fn(),
      });

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            env: expect.objectContaining({ ANTHROPIC_API_KEY: 'sk-resolved-from-env' }),
          }),
        }),
      );
      expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined();
    } finally {
      delete process.env['SPLITBRIEF_TEST_KEY'];
      if (origEnv === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = origEnv;
    }
  });

  it('threads a sandbox env through to the SDK query options.env', async () => {
    queryMock.mockImplementationOnce(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      writeFileSync(join(projectDir, 'touched.txt'), 'v2\n');
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
      yield {
        type: 'result',
        result: 'ok',
        session_id: 'sess-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });

    const cfg = makeAgentSdkConfig();
    const implementer = createAgentSdkImplementer(cfg);
    const sandboxHome = join(projectDir, '.splitbrief/sandbox', 'home');

    await implementer.implement({
      task: makeTask(),
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
      sandboxEnv: { HOME: sandboxHome },
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: expect.objectContaining({ HOME: sandboxHome }),
        }),
      }),
    );
  });

  it('throws a clear error when an env:NAME apiKey references an unset variable', () => {
    delete process.env['SPLITBRIEF_MISSING_KEY'];
    const cfg = makeAgentSdkConfig({ apiKey: 'env:SPLITBRIEF_MISSING_KEY' });
    expect(() => createAgentSdkImplementer(cfg)).toThrow(/SPLITBRIEF_MISSING_KEY/);
  });

  it('threads apiKey through to the SDK via the scoped env option without mutating process.env', async () => {
    const origEnv = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];

    // Trigger change detection success by writing a file in the stream
    queryMock.mockImplementationOnce(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      writeFileSync(join(projectDir, 'touched.txt'), 'v2\n');
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
      yield {
        type: 'result',
        result: 'ok',
        session_id: 'sess-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });

    try {
      const cfg = makeAgentSdkConfig({ apiKey: 'sk-threaded-key' });
      const implementer = createAgentSdkImplementer(cfg);

      await implementer.implement({
        task: makeTask(),
        projectDir,
        config: cfg,
        context: defaultContext,
        onOutput: vi.fn(),
      });

      expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined();
    } finally {
      if (origEnv === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = origEnv;
    }
  });

  it('threads a configured idleWarnMs override into the SDK backend', async () => {
    vi.useFakeTimers();
    queryMock.mockImplementationOnce(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      await new Promise((resolve) => setTimeout(resolve, 150));
      writeFileSync(join(projectDir, 'touched.txt'), 'v2\n');
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
      yield {
        type: 'result',
        result: 'ok',
        session_id: 'sess-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });

    const cfg = makeAgentSdkConfig({ idleWarnMs: 30 });
    const events: RunnerCallEvent[] = [];
    const publisher: ImplementerPublisher = {
      publishRunning: () => {},
      publishCallEvent: ({ event }) => events.push(event),
      publishDone: () => {},
      publishFailed: () => {},
    };
    const implementer = createAgentSdkImplementer(cfg, { publisher });

    const pending = implementer.implement({
      task: makeTask(),
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
      phase: 'implementing',
    });
    await vi.advanceTimersByTimeAsync(31);
    await vi.advanceTimersByTimeAsync(150);
    vi.useRealTimers();
    try {
      await pending;
      expect(events.some((event) => event.type === 'call_stalled')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
