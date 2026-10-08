import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import type { Check } from '../../../core/schemas/task.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { createValidator } from '../validation/run.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { runTaskLoop } from './loop.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

async function runTwoBriefs(review: 'end' | 'task') {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: `gate-cadence-${review}`,
    sessionId: `sess-gate-${review}`,
  });
  dirs.push(projectDir);
  const commands: string[] = [];
  const record: ValidationCommandRunner = async (cmd, args) => {
    commands.push([cmd, ...args].join(' '));
    return { stdout: '', stderr: '', code: 0 };
  };
  vi.spyOn(commandRunner, 'runCommand').mockImplementation(record);
  const implementer = makeImplementer({
    implement: vi.fn().mockImplementation(async (call: ImplementerOptions) => {
      const file = call.task.suggestedFiles[0] ?? 'src/missing.ts';
      mkdirSync(join(call.projectDir, dirname(file)), { recursive: true });
      writeFileSync(join(call.projectDir, file), 'export const value = 1;\n');
      return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
    }),
  });
  const { bus, events } = makeBusRecorder();
  const check = (id: string): Check => ({ id, kind: 'cmd', value: 'tsc --noEmit', required: true });

  const result = await runTaskLoop({
    wctx: makeWctx({
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { review } }),
      callbacks: makeCallbacks().callbacks,
      implementer,
      bus,
      validator: createValidator({ runCommand: record }),
    }),
    initialState: makeImplState([
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], batch: 1, checks: [check('K1')] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], batch: 2, checks: [check('K2')] }),
    ]),
    setTrackedState: vi.fn(),
    setCurrentTask: vi.fn(),
  });
  return { result, commands, events };
}

describe('runTaskLoop brief checks', { timeout: 120_000 }, () => {
  it("runs no check at workflow.review 'end': none after a brief or between batches", async () => {
    const { result, commands, events } = await runTwoBriefs('end');

    expect(result.status).toBe('complete');
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
    expect(commands).toEqual([]);
    expect(events.filter((event) => event.type === 'checks_run')).toEqual([]);
    expect(events.filter((event) => event.type === 'full_suite')).toEqual([]);
  });

  it("runs each brief's own checks after it at workflow.review 'task', and no reviewer check", async () => {
    const { result, commands, events } = await runTwoBriefs('task');

    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
    expect(commands).toEqual(['tsc --noEmit', 'tsc --noEmit']);
    expect(
      events.flatMap((event) =>
        event.type === 'checks_run' ? [[event.taskId, event.results.map((r) => r.id)]] : [],
      ),
    ).toEqual([
      ['T001', ['K1']],
      ['T002', ['K2']],
    ]);
    expect(events.filter((event) => event.type === 'full_suite')).toEqual([]);
  });
});
