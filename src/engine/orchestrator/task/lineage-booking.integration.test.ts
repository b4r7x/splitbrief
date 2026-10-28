import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeImplementer,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import {
  consultCallAnswering,
  failedReviewVerdict,
  guidanceConsult,
} from '#testing/helpers/typed-planner.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import type { ReviewAnswer } from '../../../core/schemas/review.js';
import type { TypedCallContext } from '../../planners/types.js';
import type { TypedSchemaInput } from '../../runners/typed-output.js';
import { type Check, taskId } from '../../../core/schemas/task.js';
import type { ImplementerOptions, RetryOptions } from '../../implementers/types.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { readReviewChanges } from '../../../core/evidence/review-changes.js';
import { sessionDir } from '../../../core/paths.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { endRun } from '../run/close.js';
import { buildSummary } from '../summary/build.js';
import { runTaskLoop } from './loop.js';

let dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

const CHECK: Check = { id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true };

function setupProject(): { projectDir: string; sessionId: string } {
  const ref = setupGitSessionProject({ prefix: 'lineage-booking', sessionId: 'sess-booking' });
  dirs.push(ref.projectDir);
  return ref;
}

function write(projectDir: string, file: string, text: string): void {
  mkdirSync(dirname(join(projectDir, file)), { recursive: true });
  writeFileSync(join(projectDir, file), text);
}

/** The required check fails while `failing.value` holds. */
function scriptedCheck(failing: { value: boolean }): void {
  vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
    if (!failing.value) return { stdout: '', stderr: '', code: 0 };
    throw processError.exitCode({ command: 'tsc', code: 2, stderr: 'check failed', output: '' });
  });
}

/** What the ledger books per brief, and every file it books across the run. */
function booked(ref: { projectDir: string; sessionId: string }) {
  const tasks = readEvidenceLedger(ref)?.tasks ?? [];
  return {
    byTask: Object.fromEntries(tasks.map((entry) => [entry.id, [...entry.changedFiles].sort()])),
    all: tasks.flatMap((entry) => entry.changedFiles).sort(),
  };
}

function reviewed(ref: { projectDir: string; sessionId: string }, taskId?: string): string[] {
  const changes = (readReviewChanges(ref)?.changes ?? []).filter(
    (change) => taskId === undefined || change.taskId === taskId,
  );
  return [...new Set(changes.map((change) => change.path))].sort();
}

function driftFindings(ref: { projectDir: string; sessionId: string }, taskId: string): string[] {
  const path = join(sessionDir(ref.projectDir, ref.sessionId), 'drift-report.json');
  if (!existsSync(path)) return [];
  const report = JSON.parse(readFileSync(path, 'utf8')) as {
    findings: { code: string; taskId?: string }[];
  };
  return report.findings.filter((f) => f.taskId === taskId).map((f) => f.code);
}

/**
 * T001's first attempt writes `src/a.ts`, a generated `gen/x.txt` and each of `preSplitFiles`; its local retry writes
 * `src/retry.ts`, which the consult's rollback takes back. The planner then answers each
 * consult in turn, and each task review with `review` (a passing verdict when it gives none).
 * The loop pauses at the boundary after the brief `pauseAfter` names.
 */
async function runLineage(opts: {
  answers: ((failing: { value: boolean }) => ConsultAnswer)[];
  afterConsult: (call: number, opts: ImplementerOptions | RetryOptions) => void;
  review?: (prompt: string) => ReviewAnswer | undefined;
  pauseAfter?: string;
  preSplitFiles?: readonly string[];
}) {
  const ref = setupProject();
  const failing = { value: true };
  scriptedCheck(failing);
  let consults = 0;
  let builds = 0;
  let pause = false;
  const build = async (call: ImplementerOptions | RetryOptions) => {
    builds += 1;
    if (call.task.id === opts.pauseAfter) pause = true;
    if (consults === 0 && builds === 1) {
      write(call.projectDir, 'src/a.ts', 'export const a = 1;\n');
      write(call.projectDir, 'gen/x.txt', 'generated\n');
      for (const file of opts.preSplitFiles ?? []) write(call.projectDir, file, 'pre-split\n');
    } else if (consults === 0) {
      write(call.projectDir, 'src/retry.ts', 'export const retry = 1;\n');
    } else {
      opts.afterConsult(consults, call);
    }
    return { success: true, output: 'implemented' };
  };
  const consultCall = consultCallAnswering(() => {
    const answer = opts.answers[consults] ?? (() => guidanceConsult());
    consults += 1;
    return answer(failing);
  });
  const typedCall = vi.fn((ctx: TypedCallContext) => {
    const call = consultCall(ctx);
    return {
      ...call,
      invoke: async (input: { prompt: string; schema?: TypedSchemaInput | undefined }) => {
        const verdict =
          input.schema?.name === 'review_answer' ? opts.review?.(input.prompt) : undefined;
        if (verdict === undefined) return call.invoke(input);
        return makeRunnerCallResult({
          status: 'completed',
          text: JSON.stringify(verdict),
          usage: null,
        });
      },
    };
  });
  const { bus, events } = makeBusRecorder();
  const wctx = makeWctx({
    ...ref,
    bus,
    config: makeNoValidationConfig({ workflow: { isolation: 'none', review: 'task' } }),
    planner: makePlanner({ typedCall }),
    implementer: makeImplementer({ implement: vi.fn(build), retry: vi.fn(build) }),
  });
  wctx.sinks = {
    ...wctx.sinks,
    consumeBoundaryPause: () => {
      const paused = pause;
      pause = false;
      return paused ? 'pause' : undefined;
    },
  };
  const task = makeTask({
    id: 'T001',
    suggestedFiles: ['src/a.ts', 'src/b.ts'],
    criteria: [],
    checks: [CHECK],
  });
  const result = await runTaskLoop({
    wctx,
    initialState: makeImplState([task]),
    setTrackedState: vi.fn(),
    setCurrentTask: vi.fn(),
  });
  return { ref, wctx, bus, events, result, failing };
}

function rewrite(failing: { value: boolean }, passes: boolean): ConsultAnswer {
  failing.value = !passes;
  return {
    answer: {
      diagnosis: 'The brief asks for the wrong file.',
      action: 'rewrite-task',
      task: makeTaskSpec({
        id: 'T001',
        title: 'Finish the module',
        criteria: [],
        checks: [CHECK],
        suggestedFiles: ['src/a.ts', 'src/b.ts'],
      }),
    },
  };
}

function verify(failing: { value: boolean }): ConsultAnswer {
  failing.value = false;
  return {
    answer: {
      diagnosis: 'The work is in place; the check failed on a stale cache.',
      action: 'verify',
      checkIds: ['K1'],
      reason: 'Run the check again.',
    },
  };
}

function split(
  failing: { value: boolean },
  opts: { first?: string[]; secondChecks?: Check[] } = {},
): ConsultAnswer {
  failing.value = false;
  return {
    answer: {
      diagnosis: 'T001 carries two jobs.',
      action: 'split-task',
      tasks: [
        makeTaskSpec({
          id: 'T100',
          title: 'First half',
          criteria: [],
          checks: [],
          suggestedFiles: opts.first ?? ['src/a.ts'],
        }),
        makeTaskSpec({
          id: 'T101',
          title: 'Second half',
          criteria: [],
          checks: opts.secondChecks ?? [],
          suggestedFiles: ['src/b.ts'],
          dependsOn: ['T100'],
        }),
      ],
    },
  };
}

describe('the booking of a lineage after a rewrite or a split', { timeout: 90_000 }, () => {
  it('books the files of the replaced attempts on the rewritten brief', async () => {
    const { ref, result } = await runLineage({
      answers: [(failing) => rewrite(failing, true)],
      afterConsult: (_call, opts) => write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n'),
    });

    expect(result.status).toBe('complete');
    expect(existsSync(join(ref.projectDir, 'src/retry.ts'))).toBe(false);
    expect(booked(ref).byTask).toEqual({ T001: ['gen/x.txt', 'src/a.ts', 'src/b.ts'] });
    expect(reviewed(ref)).toEqual(['gen/x.txt', 'src/a.ts', 'src/b.ts']);
  });

  it('books the replaced attempts when the new revision changes nothing and a verify passes it', async () => {
    const { ref, result } = await runLineage({
      answers: [(failing) => rewrite(failing, false), verify],
      afterConsult: () => {},
    });

    expect(result.status).toBe('complete');
    expect(result.state.tasks[0]).toMatchObject({ id: 'T001', status: 'done' });
    expect(booked(ref).byTask).toEqual({ T001: ['gen/x.txt', 'src/a.ts'] });
    expect(reviewed(ref)).toEqual(['gen/x.txt', 'src/a.ts']);
  });

  it('books the unnamed split remainder once, on the child that closes the lineage', async () => {
    const { ref, result, events } = await runLineage({
      answers: [split],
      afterConsult: (_call, opts) => {
        if (opts.task.id === 'T002') write(opts.projectDir, 'src/a.ts', 'export const a = 2;\n');
        if (opts.task.id === 'T003') write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n');
      },
    });

    expect(result.status).toBe('complete');
    expect(result.state.tasks.map((task) => [task.id, task.status])).toEqual([
      ['T002', 'done'],
      ['T003', 'done'],
    ]);
    const { byTask, all } = booked(ref);
    expect(byTask).toEqual({ T001: [], T002: ['src/a.ts'], T003: ['gen/x.txt', 'src/b.ts'] });
    expect(all).toEqual([...new Set(all)]);
    expect(reviewed(ref)).toEqual(['gen/x.txt', 'src/a.ts', 'src/b.ts']);
    expect(events.filter((event) => event.type === 'task_touched_not_suggested')).toEqual([]);
  });

  it('books the pre-split file on the child that names it when a verify passes it, with no drift', async () => {
    const { ref, result } = await runLineage({
      answers: [(failing) => split(failing, { first: ['src/a.ts', 'src/c.ts'] }), verify],
      afterConsult: () => {},
      pauseAfter: 'T002',
    });

    expect(result.status).toBe('paused');
    expect(result.state.tasks.map((task) => [task.id, task.status])).toEqual([
      ['T002', 'done'],
      ['T003', 'pending'],
    ]);
    expect(booked(ref).byTask.T002).toEqual(['src/a.ts']);
    expect(driftFindings(ref, 'T002')).not.toContain('missing_expected_file');
    expect(reviewed(ref, 'T002')).toEqual(['src/a.ts']);
  });

  it('books the pre-split file on the child that names it, not on the child that settles last', async () => {
    const { ref, result } = await runLineage({
      answers: [(failing) => split(failing, { first: ['src/a.ts', 'src/c.ts'] })],
      afterConsult: (_call, opts) => {
        if (opts.task.id === 'T002') write(opts.projectDir, 'src/c.ts', 'export const c = 1;\n');
        if (opts.task.id === 'T003') write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n');
      },
    });

    expect(result.status).toBe('complete');
    expect(booked(ref).byTask).toEqual({
      T001: [],
      T002: ['src/a.ts', 'src/c.ts'],
      T003: ['gen/x.txt', 'src/b.ts'],
    });
    expect(reviewed(ref, 'T002')).toEqual(['src/a.ts', 'src/c.ts']);
    expect(reviewed(ref, 'T003')).toEqual(['gen/x.txt', 'src/b.ts']);
  });

  it('keeps a pre-split file the second child names for the second child', async () => {
    const { ref, result } = await runLineage({
      answers: [(failing) => split(failing, { first: ['src/a.ts', 'src/c.ts'] })],
      afterConsult: (_call, opts) => {
        if (opts.task.id === 'T002') write(opts.projectDir, 'src/c.ts', 'export const c = 1;\n');
      },
      preSplitFiles: ['src/b.ts'],
    });

    expect(result.status).toBe('complete');
    expect(booked(ref).byTask.T002).not.toContain('src/b.ts');
    expect(booked(ref).byTask.T003).toContain('src/b.ts');
  });

  it('leaves a fix brief that runs between split children to its own booking', async () => {
    let reviews = 0;
    const { ref, result } = await runLineage({
      answers: [split],
      afterConsult: (_call, opts) => {
        if (opts.task.fix !== undefined)
          write(opts.projectDir, 'src/c.ts', 'export const c = 1;\n');
        if (opts.task.id === 'T002') write(opts.projectDir, 'src/a.ts', 'export const a = 2;\n');
        if (opts.task.id === 'T003') write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n');
      },
      review: (prompt) =>
        reviews++ === 0
          ? failedReviewVerdict(prompt, 'src/c.ts is missing', {
              taskId: taskId('T002'),
              file: 'src/c.ts',
            })
          : undefined,
    });

    expect(result.status).toBe('complete');
    expect(
      result.state.tasks.map((task) => [task.id, task.status, task.fix !== undefined]),
    ).toEqual([
      ['T002', 'done', false],
      ['T004', 'done', true],
      ['T003', 'done', false],
    ]);
    expect(booked(ref).byTask).toEqual({
      T001: [],
      T002: ['src/a.ts'],
      T004: ['src/c.ts'],
      T003: ['gen/x.txt', 'src/b.ts'],
    });
    expect(reviewed(ref, 'T003')).toEqual(['gen/x.txt', 'src/b.ts']);
  });

  it('books the split remainder when the user ends the run at the boundary between its children', async () => {
    const { ref, result, bus } = await runLineage({
      answers: [split],
      afterConsult: (_call, opts) => {
        if (opts.task.id === 'T002') write(opts.projectDir, 'src/a.ts', 'export const a = 2;\n');
      },
      pauseAfter: 'T002',
    });
    expect(result.status).toBe('paused');
    expect(result.state.tasks.map((task) => [task.id, task.status])).toEqual([
      ['T002', 'done'],
      ['T003', 'pending'],
    ]);
    const parked = loadState(ref);
    if (parked === null) throw new Error('Missing parked state');
    const checkoutRun = {
      ...parked,
      workspace: {
        kind: 'checkout' as const,
        path: ref.projectDir,
        base: { snapshotId: 'base', head: null },
      },
    };
    saveState(ref, checkoutRun);

    await endRun({ ...ref, bus }, checkoutRun);

    expect(booked(ref).byTask).toEqual({ T001: [], T002: ['gen/x.txt', 'src/a.ts'] });
  });

  it('leaves the first child the owner of its pre-split file when the user ends the run inside the second child', async () => {
    let check = { value: false };
    const { ref, result, bus } = await runLineage({
      answers: [
        (failing) => {
          check = failing;
          return split(failing, { first: ['src/a.ts', 'src/c.ts'], secondChecks: [CHECK] });
        },
      ],
      afterConsult: (_call, opts) => {
        if (opts.task.id === 'T002') write(opts.projectDir, 'src/c.ts', 'export const c = 1;\n');
        if (opts.task.id === 'T003') {
          check.value = true;
          write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n');
        }
      },
    });
    expect(result.state.pendingRecovery?.reason).toBe('no-progress');
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');
    const checkoutRun = {
      ...halted,
      workspace: {
        kind: 'checkout' as const,
        path: ref.projectDir,
        base: { snapshotId: 'base', head: null },
      },
    };
    saveState(ref, checkoutRun);

    const ended = await applyRecoveryAction({ ...ref, state: checkoutRun, action: 'end-run', bus });

    expect(ended.ok).toBe(true);
    expect(booked(ref).byTask).toEqual({
      T001: [],
      T002: ['src/a.ts', 'src/c.ts'],
      T003: ['gen/x.txt', 'src/b.ts'],
    });
    const closed = loadState(ref);
    if (closed === null) throw new Error('Missing closed state');
    const summary = buildSummary({
      ...ref,
      feature: 'f',
      state: closed,
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'codex',
    });
    expect(summary.stoppedAt?.taskId).toBe('T003');
    expect([...(summary.stoppedAt?.partialFiles ?? [])].sort()).toEqual(['gen/x.txt', 'src/b.ts']);
  });

  it('leaves the first child the owner of its pre-split file when the user skips the second child', async () => {
    let check = { value: false };
    const { ref, result, bus } = await runLineage({
      answers: [
        (failing) => {
          check = failing;
          return split(failing, { first: ['src/a.ts', 'src/c.ts'], secondChecks: [CHECK] });
        },
      ],
      afterConsult: (_call, opts) => {
        if (opts.task.id === 'T002') write(opts.projectDir, 'src/c.ts', 'export const c = 1;\n');
        if (opts.task.id === 'T003') {
          check.value = true;
          write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n');
        }
      },
    });
    expect(result.state.pendingRecovery?.reason).toBe('no-progress');
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');

    const skipped = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'skip-current-task',
      bus,
    });

    expect(skipped.ok).toBe(true);
    expect(booked(ref).byTask.T002).toEqual(['src/a.ts', 'src/c.ts']);
    expect(booked(ref).byTask.T003).not.toContain('src/a.ts');
  });

  it('books the replaced attempts on a rewritten brief the user skips', async () => {
    const { ref, result, bus } = await runLineage({
      answers: [(failing) => rewrite(failing, false)],
      afterConsult: (_call, opts) => write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n'),
    });
    expect(result.state.pendingRecovery?.reason).toBe('no-progress');
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');

    const skipped = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'skip-current-task',
      bus,
    });

    expect(skipped.ok).toBe(true);
    expect(existsSync(join(ref.projectDir, 'src/b.ts'))).toBe(false);
    expect(existsSync(join(ref.projectDir, 'src/a.ts'))).toBe(true);
    expect(booked(ref).byTask).toEqual({ T001: ['gen/x.txt', 'src/a.ts'] });
    expect(reviewed(ref)).toEqual(['gen/x.txt', 'src/a.ts']);
  });

  it('books the replaced attempts on a rewritten brief when the user ends the run inside it', async () => {
    const { ref, result, bus } = await runLineage({
      answers: [(failing) => rewrite(failing, false)],
      afterConsult: (_call, opts) => write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n'),
    });
    expect(result.state.pendingRecovery?.reason).toBe('no-progress');
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');
    const checkoutRun = {
      ...halted,
      workspace: {
        kind: 'checkout' as const,
        path: ref.projectDir,
        base: { snapshotId: 'base', head: null },
      },
    };
    saveState(ref, checkoutRun);

    const ended = await applyRecoveryAction({ ...ref, state: checkoutRun, action: 'end-run', bus });

    expect(ended.ok).toBe(true);
    expect(booked(ref).byTask).toEqual({ T001: ['gen/x.txt', 'src/a.ts', 'src/b.ts'] });
  });
});
