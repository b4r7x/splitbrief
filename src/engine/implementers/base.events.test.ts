import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createImplementerBase, type ImplementerBaseConfig } from './base.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import type { InvokeResult } from '../runners/types.js';

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('impl-base-events');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

function makeBaseConfig(overrides?: Partial<ImplementerBaseConfig>): ImplementerBaseConfig {
  return {
    extractsCode: true,
    invoke: vi.fn<(opts: unknown) => Promise<InvokeResult>>().mockResolvedValue({
      text: '```ts\nconst x = 1;\n```',
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
    ...overrides,
  };
}

describe('createImplementerBase — bus events', () => {
  it('publishes implementer_generate_running then implementer_generate_done on success', async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/hello.ts'), 'old content\n');

    const invoke = vi.fn().mockResolvedValue({
      text: '```ts\nexport const hello = () => "world";\n```',
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T001', file: 'src/hello.ts', action: 'modify' });
    const { bus, events } = makeBusRecorder();

    const result = await implementer.implement({
      task, projectDir, config: makeConfig(), context: defaultContext,
      onOutput: vi.fn(), bus, phase: 'implementing',
    });

    expect(result.success).toBe(true);
    const types = events.map((e) => e.type);
    expect(types).toContain('implementer_generate_running');
    expect(types).toContain('implementer_generate_done');
    const runningIdx = types.indexOf('implementer_generate_running');
    const doneIdx = types.indexOf('implementer_generate_done');
    expect(runningIdx).toBeLessThan(doneIdx);

    const running = events[runningIdx];
    if (running?.type === 'implementer_generate_running') {
      expect(running.phase).toBe('implementing');
      expect(running.taskId).toBe('T001');
      expect(running.file).toBe('src/hello.ts');
    }

    const done = events[doneIdx];
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
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T002', file: 'src/fail.ts', action: 'create' });
    const { bus, events } = makeBusRecorder();

    const result = await implementer.implement({
      task, projectDir, config: makeConfig(), context: defaultContext,
      onOutput: vi.fn(), bus, phase: 'implementing',
    });

    expect(result.success).toBe(false);
    const types = events.map((e) => e.type);
    expect(types).toContain('implementer_generate_running');
    expect(types).toContain('implementer_generate_failed');
    expect(types.indexOf('implementer_generate_running')).toBeLessThan(types.indexOf('implementer_generate_failed'));
  });

  it('does not publish any events when bus is not provided', async () => {
    const invoke = vi.fn().mockResolvedValue({
      text: '```ts\nconst x = 1;\n```',
      usage: null,
    });
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));

    const result = await implementer.implement({
      task: makeTask(), projectDir, config: makeConfig(), context: defaultContext, onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
  });
});
