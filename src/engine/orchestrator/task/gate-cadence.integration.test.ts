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
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import type { Check, Task } from '../../../core/schemas/task.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import type { Planner } from '../../planners/types.js';
import type { EngineEvent } from '../../events/types.js';
import { createValidator } from '../validation/run.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { runTaskLoop } from './loop.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

const check = (id: string): Check => ({ id, kind: 'cmd', value: 'tsc --noEmit', required: true });

async function runBriefs(opts: {
  review: 'end' | 'task';
  tasks: Task[];
  /** The first runs of a check command fail with a type error. */
  red?: number;
  /** A command that always fails with a type error, as a red the brief did not cause. */
  alwaysRed?: string;
  planner?: Planner;
}) {
  const { review } = opts;
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: `gate-cadence-${review}`,
    sessionId: `sess-gate-${review}`,
  });
  dirs.push(projectDir);
  const commands: string[] = [];
  let red = opts.red ?? 0;
  const record: ValidationCommandRunner = async (cmd, args) => {
    const command = [cmd, ...args].join(' ');
    commands.push(command);
    if (command === opts.alwaysRed) {
      throw processError.exitCode({ command: cmd, code: 2, stderr: TYPE_ERROR });
    }
    if (red > 0) {
      red -= 1;
      throw processError.exitCode({ command: cmd, code: 2, stderr: TYPE_ERROR });
    }
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

  const result = await runTaskLoop({
    wctx: makeWctx({
      projectDir,
      sessionId,
      config: makeConfig({ workflow: { review } }),
      callbacks: makeCallbacks().callbacks,
      implementer,
      bus,
      validator: createValidator({ runCommand: record }),
      ...(opts.planner === undefined ? {} : { planner: opts.planner }),
    }),
    initialState: makeImplState(opts.tasks),
    setTrackedState: vi.fn(),
    setCurrentTask: vi.fn(),
  });
  return { result, commands, events, implementer };
}

function runTwoBriefs(review: 'end' | 'task') {
  return runBriefs({
    review,
    tasks: [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], batch: 1, checks: [check('K1')] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], batch: 2, checks: [check('K2')] }),
    ],
  });
}

const TYPE_ERROR =
  "src/alpha.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.";

function oneBrief(checks: Check[]) {
  return [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], checks })];
}

function briefChecksRun(events: readonly EngineEvent[]) {
  return events.flatMap((event) =>
    event.type === 'checks_run' ? [[event.taskId, event.results.map((r) => r.id)]] : [],
  );
}

describe('runTaskLoop brief checks', { timeout: 120_000 }, () => {
  it("runs each brief's own checks after it at workflow.review 'end', and nothing between batches", async () => {
    const { result, commands, events } = await runTwoBriefs('end');

    expect(result.status).toBe('complete');
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
    expect(commands).toEqual(['tsc --noEmit', 'tsc --noEmit']);
    expect(briefChecksRun(events)).toEqual([
      ['T001', ['K1']],
      ['T002', ['K2']],
    ]);
    expect(
      events.flatMap((event) =>
        event.type === 'task_validating' && event.check !== undefined
          ? [[event.taskId, event.check.id, event.check.command]]
          : [],
      ),
    ).toEqual([
      ['T001', 'K1', 'tsc --noEmit'],
      ['T002', 'K2', 'tsc --noEmit'],
    ]);
    expect(events.filter((event) => event.type === 'full_suite')).toEqual([]);
  });

  it("retries a brief whose own check is red at workflow.review 'end' with the check output", async () => {
    const { result, commands, implementer } = await runBriefs({
      review: 'end',
      tasks: oneBrief([check('K1')]),
      red: 1,
    });

    expect(result.state.tasks.map((task) => task.status)).toEqual(['done']);
    expect(commands).toEqual(['tsc --noEmit', 'tsc --noEmit']);
    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(implementer.retry).mock.calls[0]?.[0]).toMatchObject({
      kind: 'local',
      error: expect.stringContaining(TYPE_ERROR),
    });
  });

  it("consults on a brief whose own check stays red after the retry at workflow.review 'end'", async () => {
    const consult = vi.fn((_prompt: string) => guidanceConsult());
    const { result, commands } = await runBriefs({
      review: 'end',
      tasks: oneBrief([check('K1')]),
      red: 2,
      planner: makePlanner({ typedCall: consultCallAnswering(consult) }),
    });

    expect(consult).toHaveBeenCalledTimes(1);
    expect(consult.mock.calls[0]?.[0]).toContain(TYPE_ERROR);
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done']);
    expect(commands).toEqual(Array(3).fill('tsc --noEmit'));
  });

  it("runs only the checks a consult verify names at workflow.review 'end'", async () => {
    const lint: Check = { id: 'K2', kind: 'cmd', value: 'eslint src/alpha.ts', required: true };
    const consult = vi.fn((_prompt: string) => ({
      answer: {
        diagnosis: 'The type error is in a file this task did not touch.',
        action: 'verify' as const,
        checkIds: ['K2'],
        reason: 'The red predates this task.',
      },
    }));
    const { result, commands } = await runBriefs({
      review: 'end',
      tasks: oneBrief([check('K1'), lint]),
      alwaysRed: 'tsc --noEmit',
      planner: makePlanner({ typedCall: consultCallAnswering(consult) }),
    });

    expect(consult).toHaveBeenCalledTimes(1);
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done']);
    expect(commands.slice(-1)).toEqual(['eslint src/alpha.ts']);
  });

  it("runs no check for a brief without checks at workflow.review 'end'", async () => {
    const { result, commands, events } = await runBriefs({ review: 'end', tasks: oneBrief([]) });

    expect(result.state.tasks.map((task) => task.status)).toEqual(['done']);
    expect(commands).toEqual([]);
    expect(briefChecksRun(events)).toEqual([]);
  });

  it("leaves a brief's render check to the review at workflow.review 'end'", async () => {
    const { result, commands, events } = await runBriefs({
      review: 'end',
      tasks: oneBrief([
        check('K1'),
        { id: 'K2', kind: 'render', value: 'workflow-build-progress', required: true },
      ]),
    });

    expect(result.state.tasks.map((task) => task.status)).toEqual(['done']);
    expect(commands).toEqual(['tsc --noEmit']);
    expect(briefChecksRun(events)).toEqual([['T001', ['K1']]]);
  });

  it("runs each brief's own checks after it and the covered required checks again at each task review at workflow.review 'task', and no reviewer check", async () => {
    const { result, commands, events } = await runTwoBriefs('task');

    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
    // T001 gate K1, T001 review K1, T002 gate K2, T002 review K1 and K2.
    expect(commands).toEqual(Array(5).fill('tsc --noEmit'));
    expect(
      events.flatMap((event) =>
        event.type === 'checks_run' ? [[event.taskId, event.results.map((r) => r.id)]] : [],
      ),
    ).toEqual([
      ['T001', ['K1']],
      ['T001', ['K1']],
      ['T002', ['K2']],
      ['T001', ['K1']],
      ['T002', ['K2']],
    ]);
    expect(
      events.flatMap((event) =>
        event.type === 'full_suite' ? [[event.moment, event.id, event.status]] : [],
      ),
    ).toEqual([
      ['plan', 'K1', 'running'],
      ['plan', 'K1', 'done'],
      ['plan', 'K1', 'running'],
      ['plan', 'K1', 'done'],
      ['plan', 'K2', 'running'],
      ['plan', 'K2', 'done'],
    ]);
  });
});
