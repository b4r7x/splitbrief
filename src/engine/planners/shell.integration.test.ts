import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createShellPlanner } from './shell.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { z } from 'zod';
import { requestTyped } from '../runners/typed-output.js';
import { processError } from '../../lib/process/errors.js';

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

  it('serves a typed planner answer from stdout', async () => {
    const config = makeConfig({
      planner: {
        kind: 'shell',
        command: 'bash',
        args: [
          '-c',
          'case "$(cat)" in *"No prose after it.") echo \'Result: {"answer":"s","count":4}\';; esac',
        ],
      },
    });
    const planner = createShellPlanner(config);

    const result = await requestTyped({
      prompt: 'q',
      schema: z.object({ answer: z.string(), count: z.number() }),
      jsonSchema: { type: 'object' },
      schemaName: 'probe',
      call: planner.typedCall({ projectDir, callbacks: { onOutput: vi.fn() }, seat: 'planner' }),
    });

    expect(result).toMatchObject({ value: { answer: 's', count: 4 } });
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

  it('ends a review call at a configured timeout', async () => {
    const config = makeConfig({
      planner: { kind: 'shell', command: 'bash', args: ['-c', 'sleep 5'], timeout: 150 },
    });
    const planner = createShellPlanner(config);

    await expect(planner.review('prompt', projectDir, { onOutput: vi.fn() })).rejects.toSatisfy(
      processError.isTimeout,
    );
  });
});
