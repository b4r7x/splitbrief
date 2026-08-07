import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createImplementerBase } from './run.js';
import type { ImplementerPublisher } from '../types.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBaseConfig } from '#testing/helpers/factories/implementer-base.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';

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
      duration: number;
    }
  | {
      type: 'implementer_generate_failed';
      phase: string;
      taskId: string;
      model?: string | undefined;
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
    const task = makeTask({ id: 'T001', file: 'src/hello.ts', action: 'modify' });
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
      expect(typeof done.duration).toBe('number');
      expect(done.duration).toBeGreaterThanOrEqual(0);
    }
  });

  it('publishes implementer_generate_running then implementer_generate_failed on invoke error', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('connection refused'));
    const task = makeTask({ id: 'T002', file: 'src/fail.ts', action: 'create' });
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
    const task = makeTask({ id: 'T002', file: 'src/fail.ts', action: 'create' });
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

  it('does not publish implementer_generate_failed when invoke aborts after running', async () => {
    const controller = new AbortController();
    const invoke = vi.fn().mockImplementation(() => {
      controller.abort(new Error('cancelled'));
      return Promise.reject(new Error('cancelled'));
    });
    const task = makeTask({ id: 'T003', file: 'src/abort.ts', action: 'create' });
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
