import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createImplementerBase } from './run.js';
import type { ImplementerPublisher } from '../types.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBaseConfig } from '#testing/helpers/factories/implementer-base.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { createChangeDetector } from '../../change-detection.js';
import { createEventBus } from '../../events/bus.js';
import { createImplementerPublisher } from '../../orchestrator/events.js';
import type { EngineEvent } from '../../events/types.js';

type PublisherEvent =
  | {
      type: 'implementer_generate_running';
      phase: string;
      taskId: string;
      file?: string | undefined;
    }
  | {
      type: 'implementer_generate_done';
      phase: string;
      taskId: string;
      file: string;
      files: string[];
      duration: number;
    }
  | {
      type: 'implementer_generate_failed';
      phase: string;
      taskId: string;
      model?: string | undefined;
      error?: string | undefined;
    };

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('impl-base-events');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

function makePublisher(events: PublisherEvent[]): ImplementerPublisher {
  return {
    publishRunning: (event) => events.push({ type: 'implementer_generate_running', ...event }),
    publishCallEvent: () => {},
    publishDone: (event) => events.push({ type: 'implementer_generate_done', ...event }),
    publishFailed: (event) => events.push({ type: 'implementer_generate_failed', ...event }),
    publishWarning: () => {},
  };
}

describe('createImplementerBase — bus events', () => {
  it('publishes only applied bundle files, in brief order', async () => {
    const events: PublisherEvent[] = [];
    const implementer = createImplementerBase(
      makeBaseConfig({
        backendKind: 'api',
        publisher: makePublisher(events),
        invoke: async () =>
          makeRunnerCallResult({
            status: 'completed',
            text: JSON.stringify({
              version: 1,
              files: [
                { path: 'test/text.test.js', action: 'create', content: 'new test' },
                { path: 'src/text.js', action: 'create', content: 'new source' },
              ],
            }),
          }),
      }),
    );
    const result = await implementer.implement({
      task: makeTask({
        action: 'create',
        suggestedFiles: ['src/text.js', 'test/text.test.js', 'src/untouched.js'],
      }),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: () => {},
      phase: 'implementing',
    });
    expect(result.success).toBe(true);
    expect(events.find((event) => event.type === 'implementer_generate_done')).toMatchObject({
      file: 'src/text.js',
      files: ['src/text.js', 'test/text.test.js'],
      linesAdded: 2,
      linesRemoved: 0,
    });
  });

  it('publishes an empty file list for an allowed no-change verification', async () => {
    const events: PublisherEvent[] = [];
    const implementer = createImplementerBase(
      makeBaseConfig({
        extractsCode: false,
        detectChanges: createChangeDetector('Direct implementer'),
        publisher: makePublisher(events),
        invoke: async () => makeRunnerCallResult({ status: 'completed', text: 'Already correct' }),
      }),
    );
    const result = await implementer.implement({
      task: makeTask({ suggestedFiles: ['src/text.js', 'test/text.test.js'] }),
      projectDir,
      allowNoChange: true,
      config: makeConfig(),
      context: defaultContext,
      onOutput: () => {},
      phase: 'implementing',
    });
    expect(result.success).toBe(true);
    expect(events.find((event) => event.type === 'implementer_generate_done')).toMatchObject({
      file: 'src/text.js',
      files: [],
      noChange: true,
    });
  });

  it.each(['git-status', 'file-hashes'] as const)(
    'publishes all direct-writer changes from a %s baseline',
    async (changeDetection) => {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      mkdirSync(join(projectDir, 'test'), { recursive: true });
      writeFileSync(join(projectDir, 'src/text.js'), 'dirty source\n');
      writeFileSync(join(projectDir, 'src/untouched.js'), 'dirty and untouched\n');
      const bus = createEventBus();
      const events: EngineEvent[] = [];
      bus.subscribe((event) => events.push(event));
      const implementer = createImplementerBase(
        makeBaseConfig({
          extractsCode: false,
          detectChanges: createChangeDetector('Direct implementer'),
          publisher: createImplementerPublisher(bus),
          invoke: async () => {
            writeFileSync(join(projectDir, 'src/text.js'), 'new source\n');
            writeFileSync(join(projectDir, 'test/text.test.js'), 'new test');
            return makeRunnerCallResult({ status: 'completed', text: 'done' });
          },
        }),
      );
      const result = await implementer.implement({
        task: makeTask({ suggestedFiles: ['src/text.js', 'test/text.test.js'] }),
        projectDir,
        changeDetection,
        config: makeConfig(),
        context: defaultContext,
        onOutput: () => {},
        phase: 'implementing',
      });

      expect(result.success).toBe(true);
      expect(events.find((event) => event.type === 'implementer_generate_done')).toMatchObject({
        file: 'src/text.js',
        files: ['src/text.js', 'test/text.test.js'],
        ...(changeDetection === 'git-status' ? { linesAdded: 2, linesRemoved: 1 } : {}),
      });
      if (changeDetection === 'file-hashes') {
        expect(
          events.find((event) => event.type === 'implementer_generate_done'),
        ).not.toHaveProperty('linesAdded');
      }
    },
  );

  it.each(['git-status', 'file-hashes'] as const)(
    'publishes a mode-only change and a new symlink from a %s baseline',
    async (changeDetection) => {
      chmodSync(join(projectDir, 'init.txt'), 0o644);
      const events: PublisherEvent[] = [];
      const implementer = createImplementerBase(
        makeBaseConfig({
          extractsCode: false,
          detectChanges: createChangeDetector('Direct implementer'),
          publisher: makePublisher(events),
          invoke: async () => {
            chmodSync(join(projectDir, 'init.txt'), 0o755);
            symlinkSync('init.txt', join(projectDir, 'readme.md'));
            return makeRunnerCallResult({ status: 'completed', text: 'done' });
          },
        }),
      );
      const result = await implementer.implement({
        task: makeTask({ suggestedFiles: ['init.txt'] }),
        projectDir,
        changeDetection,
        config: makeConfig(),
        context: defaultContext,
        onOutput: () => {},
        phase: 'implementing',
      });

      expect(result.success).toBe(true);
      expect(events.find((event) => event.type === 'implementer_generate_done')).toMatchObject({
        files: ['init.txt', 'readme.md'],
      });
    },
  );

  it('publishes implementer_generate_running then implementer_generate_done on success', async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/hello.ts'), 'old content\n');

    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: '```ts\nexport const hello = () => "world";\n```',
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    );
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/hello.ts'], action: 'modify' });
    const events: PublisherEvent[] = [];
    const implementer = createImplementerBase(
      makeBaseConfig({ invoke, publisher: makePublisher(events) }),
    );

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      phase: 'implementing',
    });

    expect(result.success).toBe(true);
    const types = events.map((e) => e.type);
    expect(types).toContain('implementer_generate_running');
    expect(types).toContain('implementer_generate_done');
    const running = events.find((e) => e.type === 'implementer_generate_running');
    if (running?.type === 'implementer_generate_running') {
      expect(running.phase).toBe('implementing');
      expect(running.taskId).toBe('T001');
      expect(running.file).toBe('src/hello.ts');
    }

    const done = events.find((e) => e.type === 'implementer_generate_done');
    if (done?.type === 'implementer_generate_done') {
      expect(done.phase).toBe('implementing');
      expect(done.taskId).toBe('T001');
      expect(done.file).toBe('src/hello.ts');
      expect(done.files).toEqual(['src/hello.ts']);
      expect(typeof done.duration).toBe('number');
      expect(done.duration).toBeGreaterThanOrEqual(0);
    }
  });

  it('publishes implementer_generate_running then implementer_generate_failed on invoke error', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('connection refused'));
    const task = makeTask({ id: 'T002', suggestedFiles: ['src/fail.ts'], action: 'create' });
    const events: PublisherEvent[] = [];
    const implementer = createImplementerBase(
      makeBaseConfig({ invoke, publisher: makePublisher(events) }),
    );

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      phase: 'implementing',
    });

    expect(result.success).toBe(false);
    const types = events.map((e) => e.type);
    expect(types).toContain('implementer_generate_running');
    expect(types).toContain('implementer_generate_failed');
    expect(types.indexOf('implementer_generate_running')).toBeLessThan(
      types.indexOf('implementer_generate_failed'),
    );
  });

  it('publishes implementer_generate_failed without fabricating a backend-default model', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('connection refused'));
    const task = makeTask({ id: 'T002', suggestedFiles: ['src/fail.ts'], action: 'create' });
    const events: PublisherEvent[] = [];
    const implementer = createImplementerBase(
      makeBaseConfig({ invoke, publisher: makePublisher(events) }),
    );

    await implementer.implement({
      task,
      projectDir,
      config: makeConfig({ implementer: { kind: 'cli', tool: 'codex' } }),
      context: defaultContext,
      onOutput: vi.fn(),
      phase: 'implementing',
    });

    const failed = events.find((event) => event.type === 'implementer_generate_failed');
    expect(failed).toBeDefined();
    expect(failed && 'model' in failed).toBe(false);
  });

  // Run 2026-10-05-s6-central-checks-and-renders-plus-the-carried-in--3, T010 attempts 2 and 3:
  // the CLI call recorded `runner_call_completed`, then the effect check turned it into a failed
  // `no-staged-change` result, and `implementer_generate_failed` said only `{ model }`.
  it('a call that completed and then failed its effect check names the cause on implementer_generate_failed', async () => {
    const cause = 'Tool implementer (opencode) exited without changing any files';
    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'failed',
        text: 'Fixed.\n\n{"status":"done","filesChanged":[],"touchedNotSuggested":[],"notes":null,"decisions":[]}',
        error: { code: 'no-staged-change', message: cause },
        partial: true,
      }),
    );
    const task = makeTask({ id: 'T010', suggestedFiles: ['src/core/pipeline-spec/bounds.ts'] });
    const events: PublisherEvent[] = [];
    const implementer = createImplementerBase(
      makeBaseConfig({ extractsCode: false, invoke, publisher: makePublisher(events) }),
    );

    const result = await implementer.retry({
      task,
      projectDir,
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
      }),
      context: defaultContext,
      onOutput: vi.fn(),
      phase: 'implementing',
      error: 'TS2322 in src/engine/implementers/pipeline/call-result.ts',
      attempt: 1,
      kind: 'local',
    });

    expect(result).toMatchObject({ success: false, outcome: 'no-staged-change' });
    expect(events.find((event) => event.type === 'implementer_generate_failed')).toEqual({
      type: 'implementer_generate_failed',
      phase: 'implementing',
      taskId: 'T010',
      model: 'opencode-go/deepseek-v4.1-flash',
      error: result.error,
    });
    expect(result.error).toContain(cause);
  });

  it('a completed call whose change check finds nothing names that cause on implementer_generate_failed', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue(makeRunnerCallResult({ status: 'completed', text: 'done' }));
    const detectChanges = vi.fn().mockResolvedValue({
      changed: false,
      output: 'Tool implementer (opencode) exited without changing any files',
      reason: 'no-files-changed',
    });
    const events: PublisherEvent[] = [];
    const implementer = createImplementerBase(
      makeBaseConfig({
        extractsCode: false,
        invoke,
        detectChanges,
        publisher: makePublisher(events),
      }),
    );

    const result = await implementer.implement({
      task: makeTask({ id: 'T011', suggestedFiles: ['src/a.ts'] }),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      phase: 'implementing',
    });

    expect(result).toMatchObject({ success: false, outcome: 'no-staged-change' });
    expect(events.find((event) => event.type === 'implementer_generate_failed')).toMatchObject({
      error: 'Tool implementer (opencode) exited without changing any files',
    });
  });

  it('does not publish implementer_generate_failed when invoke aborts after running', async () => {
    const controller = new AbortController();
    const invoke = vi.fn().mockImplementation(() => {
      controller.abort(new Error('cancelled'));
      return Promise.reject(new Error('cancelled'));
    });
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/abort.ts'], action: 'create' });
    const events: PublisherEvent[] = [];
    const implementer = createImplementerBase(
      makeBaseConfig({ invoke, publisher: makePublisher(events) }),
    );

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      phase: 'implementing',
      signal: controller.signal,
    });

    expect(result).toMatchObject({ success: false, error: 'Aborted' });
    expect(events.map((event) => event.type)).toEqual(['implementer_generate_running']);
  });
});
