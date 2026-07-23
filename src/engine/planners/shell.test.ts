import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createShellPlanner } from './shell.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { join } from 'node:path';
import type { RunnerCallEvent } from '../calls/types.js';

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('shell-planner-test');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createShellPlanner', () => {
  it('throws for wrong config kind', () => {
    const config = makeConfig({ planner: { kind: 'agent', command: 'echo' } });
    expect(() => createShellPlanner(config)).toThrow('Expected shell planner config');
  });

  it('escalateHint — success when shell command writes files', async () => {
    const outFile = join(projectDir, 'hint-out.ts');
    const config = makeConfig({
      planner: {
        kind: 'shell',
        command: 'bash',
        args: ['-c', `echo "// hint" > ${outFile}`],
        capabilities: { supportsHintEscalation: true },
      },
    });
    const planner = createShellPlanner(config);
    const task = makeTask();
    const callbacks = { onOutput: vi.fn() };

    const result = await planner.escalateHint({
      task,
      error: 'error message',
      projectDir,
      callbacks,
    });
    expect(result.success).toBe(true);
    expect(result.code).toBe(null);
  });

  it('threads a configured idleWarnMs override into the spawn', async () => {
    const config = makeConfig({
      planner: {
        kind: 'shell',
        command: 'bash',
        args: ['-c', 'sleep 0.15'],
        idleWarnMs: 30,
      },
    });
    const planner = createShellPlanner(config);
    const events: RunnerCallEvent[] = [];

    await planner.review('prompt', projectDir, {
      onOutput: vi.fn(),
      onCallEvent: (event) => events.push(event),
    });

    expect(events.some((event) => event.type === 'call_stalled')).toBe(true);
  });
});
