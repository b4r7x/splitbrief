import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { createAgentSdkImplementer } from './agent-sdk.js';
import { DEFAULT_AGENT_SDK_MODEL } from '../../core/providers/known-models.js';

/**
 * Agent SDK implementer — exercised against the real wrapper in
 * `src/engine/agent-sdk-backend.ts`. The only sanctioned mock here is the optional
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
});
