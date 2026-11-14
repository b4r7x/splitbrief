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
import type { ReviewAnswer } from '../../../core/schemas/review/verdict.js';
import type { TypedCallContext } from '../../planners/types.js';
import type { EngineEvent } from '../../events/types.js';
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
import type { HooksConfig } from '../../../core/schemas/hooks.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { restoreInterruptedTaskFiles } from './rollback.js';

let dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

const CHECK: Check = { id: 'K1', kind: 'cmd', value: 'tsc --noEmit' };

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

/** The files a rewrite or a split leaves in the run: both early attempts' and the replacement's. */
const LINEAGE_FILES = ['gen/x.txt', 'src/a.ts', 'src/b.ts', 'src/retry.ts'];

function read(ref: { projectDir: string }, file: string): string | undefined {
  const path = join(ref.projectDir, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function present(ref: { projectDir: string }, files: readonly string[]): string[] {
  return files.filter((file) => existsSync(join(ref.projectDir, file)));
}

function warnings(events: readonly EngineEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'warning' ? [event.message] : []));
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

/** The `Touched, Not Suggested` section of a review prompt: the booked files no brief names. */
function touchedSection(prompt: string): string {
  const [, section] = prompt.split('## Touched, Not Suggested\n');
  if (section === undefined)
    throw new Error('The review prompt has no Touched, Not Suggested section');
  return section.split('\n## ')[0] ?? '';
}

/**
 * T001's first attempt writes `src/a.ts`, a generated `gen/x.txt` and each of `preSplitFiles`.
 * The planner answers the first consult with guidance, so a guided retry that writes
 * `src/retry.ts` runs between attempt 1 and the rewrite or split; the rewrite or split keeps
 * every file of both attempts. The planner then answers each later consult with `answers` in turn, fails
 * its call past the last answer, and answers each task review with
 * `review` (a passing verdict when it gives none).
 * The loop pauses at the boundary after the brief `pauseAfter` names. With `atPause`, the user
 * edits the checkout there and the loop runs on.
 */
async function runLineage(opts: {
  answers: ((failing: { value: boolean }) => ConsultAnswer)[];
  afterConsult: (call: number, opts: ImplementerOptions | RetryOptions) => void;
  review?: (prompt: string) => ReviewAnswer | undefined;
  pauseAfter?: string;
  atPause?: (projectDir: string) => void;
  preSplitFiles?: readonly string[];
  hooks?: (projectDir: string) => HooksConfig;
}) {
  const ref = setupProject();
  const hooks = opts.hooks?.(ref.projectDir);
  if (hooks !== undefined) markHooksConfigTrusted(ref.projectDir, hooks);
  const failing = { value: true };
  scriptedCheck(failing);
  let consults = 0;
  let pause = false;
  const build = async (call: ImplementerOptions | RetryOptions) => {
    if (call.task.id === opts.pauseAfter) pause = true;
    if (consults === 0) {
      write(call.projectDir, 'src/a.ts', 'export const a = 1;\n');
      write(call.projectDir, 'gen/x.txt', 'generated\n');
      for (const file of opts.preSplitFiles ?? []) write(call.projectDir, file, 'pre-split\n');
    } else if (consults === 1) {
      write(call.projectDir, 'src/retry.ts', 'export const retry = 1;\n');
    } else {
      opts.afterConsult(consults - 1, call);
    }
    return { success: true, output: 'implemented' };
  };
  const consultCall = consultCallAnswering(() => {
    consults += 1;
    if (consults === 1) return guidanceConsult();
    const answer = opts.answers[consults - 2];
    if (answer === undefined) throw new Error('The planner process stopped unexpectedly.');
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
    config: makeNoValidationConfig({
      workflow: { isolation: 'none', review: 'task' },
      ...(hooks !== undefined && { hooks }),
    }),
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
  let result = await runTaskLoop({
    wctx,
    initialState: makeImplState([task]),
    setTrackedState: vi.fn(),
    setCurrentTask: vi.fn(),
  });
  if (result.status === 'paused' && opts.atPause !== undefined) {
    opts.atPause(ref.projectDir);
    const parked = loadState(ref);
    if (parked === null) throw new Error('Missing parked state');
    result = await runTaskLoop({
      wctx,
      initialState: parked,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
  }
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
  opts: {
    first?: string[];
    firstChecks?: Check[];
    secondChecks?: Check[];
    independent?: boolean;
  } = {},
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
          checks: opts.firstChecks ?? [],
          suggestedFiles: opts.first ?? ['src/a.ts'],
        }),
        makeTaskSpec({
          id: 'T101',
          title: 'Second half',
          criteria: [],
          checks: opts.secondChecks ?? [],
          suggestedFiles: ['src/b.ts'],
          dependsOn: opts.independent === true ? [] : ['T100'],
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
    expect(existsSync(join(ref.projectDir, 'src/retry.ts'))).toBe(true);
    expect(booked(ref).byTask).toEqual({
      T001: ['gen/x.txt', 'src/a.ts', 'src/b.ts', 'src/retry.ts'],
    });
    expect(reviewed(ref)).toEqual(['gen/x.txt', 'src/a.ts', 'src/b.ts', 'src/retry.ts']);
  });

  it('books the replaced attempts when the new revision changes nothing and a verify passes it', async () => {
    const { ref, result } = await runLineage({
      answers: [(failing) => rewrite(failing, false), verify],
      afterConsult: () => {},
    });

    expect(result.status).toBe('complete');
    expect(result.state.tasks[0]).toMatchObject({ id: 'T001', status: 'done' });
    expect(booked(ref).byTask).toEqual({ T001: ['gen/x.txt', 'src/a.ts', 'src/retry.ts'] });
    expect(reviewed(ref)).toEqual(['gen/x.txt', 'src/a.ts', 'src/retry.ts']);
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
    expect(existsSync(join(ref.projectDir, 'src/retry.ts'))).toBe(true);
    const { byTask, all } = booked(ref);
    expect(byTask).toEqual({
      T001: [],
      T002: ['src/a.ts'],
      T003: ['gen/x.txt', 'src/b.ts', 'src/retry.ts'],
    });
    expect(all).toEqual([...new Set(all)]);
    expect(reviewed(ref)).toEqual(['gen/x.txt', 'src/a.ts', 'src/b.ts', 'src/retry.ts']);
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
      T003: ['gen/x.txt', 'src/b.ts', 'src/retry.ts'],
    });
    expect(reviewed(ref, 'T002')).toEqual(['src/a.ts', 'src/c.ts']);
    expect(reviewed(ref, 'T003')).toEqual(['gen/x.txt', 'src/b.ts', 'src/retry.ts']);
  });

  it('books a kept file of the replaced attempt on the child that names it, with no drift for it', async () => {
    const reviews: string[] = [];
    const { ref, result, events } = await runLineage({
      answers: [(failing) => split(failing, { first: ['src/a.ts', 'src/c.ts', 'src/retry.ts'] })],
      afterConsult: (_call, opts) => {
        if (opts.task.id === 'T002') write(opts.projectDir, 'src/c.ts', 'export const c = 1;\n');
        if (opts.task.id === 'T003') write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n');
      },
      review: (prompt) => {
        reviews.push(prompt);
        return undefined;
      },
    });

    expect(result.status).toBe('complete');
    expect(booked(ref).byTask).toEqual({
      T001: [],
      T002: ['src/a.ts', 'src/c.ts', 'src/retry.ts'],
      T003: ['gen/x.txt', 'src/b.ts'],
    });
    expect(reviews).toHaveLength(2);
    for (const review of reviews) expect(touchedSection(review)).not.toContain('src/retry.ts');
    expect(events.filter((event) => event.type === 'task_touched_not_suggested')).toEqual([]);
  });

  it('books the unnamed kept files on the child that closes the lineage, with no drift for them on the other child', async () => {
    const reviews: string[] = [];
    const { result } = await runLineage({
      answers: [split],
      afterConsult: (_call, opts) => {
        if (opts.task.id === 'T002') write(opts.projectDir, 'src/a.ts', 'export const a = 2;\n');
        if (opts.task.id === 'T003') write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n');
      },
      review: (prompt) => {
        reviews.push(prompt);
        return undefined;
      },
    });

    expect(result.status).toBe('complete');
    expect(reviews).toHaveLength(2);
    for (const review of reviews) expect(touchedSection(review)).not.toContain('T002:');
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
      T003: ['gen/x.txt', 'src/b.ts', 'src/retry.ts'],
    });
    expect(reviewed(ref, 'T003')).toEqual(['gen/x.txt', 'src/b.ts', 'src/retry.ts']);
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

    expect(booked(ref).byTask).toEqual({
      T001: [],
      T002: ['gen/x.txt', 'src/a.ts', 'src/retry.ts'],
    });
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
    expect(result.state.pendingRecovery?.reason).toBe('planner-call-failed');
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
    // The halt kept src/b.ts, the second child's own file, so the second child books it.
    expect(booked(ref).byTask).toEqual({
      T001: [],
      T002: ['src/a.ts', 'src/c.ts'],
      T003: ['gen/x.txt', 'src/b.ts', 'src/retry.ts'],
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
    expect([...(summary.stoppedAt?.partialFiles ?? [])].sort()).toEqual([
      'gen/x.txt',
      'src/b.ts',
      'src/retry.ts',
    ]);
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
    expect(result.state.pendingRecovery?.reason).toBe('planner-call-failed');
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

  it('takes back the replaced attempts of a rewritten brief the user skips', async () => {
    const { ref, result, bus, events } = await runLineage({
      answers: [(failing) => rewrite(failing, false)],
      afterConsult: (_call, opts) => write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n'),
    });
    expect(result.state.pendingRecovery?.reason).toBe('planner-call-failed');
    // The halt keeps the rewritten brief's files, so Try again continues on them.
    expect(present(ref, LINEAGE_FILES)).toEqual(LINEAGE_FILES);
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');

    const skipped = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'skip-current-task',
      bus,
    });

    expect(skipped.ok).toBe(true);
    expect(present(ref, LINEAGE_FILES)).toEqual([]);
    expect(booked(ref).byTask).toEqual({ T001: [] });
    expect(reviewed(ref)).toEqual([]);
    expect(warnings(events).at(-1)).toMatch(
      /Restored 3 changes of the attempts before the rewrite or split: gen\/x\.txt, src\/a\.ts, src\/retry\.ts/,
    );
  });

  it('takes back the replaced attempts when a pre_validation hook denies the rewritten brief', async () => {
    const trust = useTrustHome('lineage-booking-trust-home');
    try {
      const { ref, result, events } = await runLineage({
        answers: [(failing) => rewrite(failing, false)],
        afterConsult: (_call, opts) => write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n'),
        hooks: (projectDir) => {
          // The count lives outside the project, so the hook writes no file of the run.
          const calls = join(trust.home, 'hook-calls');
          writeFileSync(
            join(projectDir, '.deny-third-validation.mjs'),
            [
              "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
              `const calls = ${JSON.stringify(calls)};`,
              "const count = existsSync(calls) ? Number(readFileSync(calls, 'utf8')) + 1 : 1;",
              'writeFileSync(calls, String(count));',
              "if (count === 3) console.log(JSON.stringify({ decision: 'deny', message: 'policy' }));",
              '',
            ].join('\n'),
          );
          return {
            pre_validation: [
              {
                kind: 'command',
                command: 'node',
                args: ['.deny-third-validation.mjs'],
                timeout_ms: 30_000,
                on_failure: 'warn',
              },
            ],
          };
        },
      });

      expect(result.state.tasks.map((task) => [task.id, task.status])).toEqual([
        ['T001', 'skipped'],
      ]);
      expect(present(ref, LINEAGE_FILES)).toEqual([]);
      expect(booked(ref).byTask).toEqual({ T001: [] });
      expect(warnings(events).at(-1)).toMatch(
        /after pre_validation denied: src\/b\.ts\..* Restored 3 changes of the attempts before the rewrite or split: gen\/x\.txt, src\/a\.ts, src\/retry\.ts/,
      );
    } finally {
      trust.restore();
    }
  });

  it('takes back the edit a replaced attempt made to a done brief file when the user skips the rewritten brief', async () => {
    const ref = setupProject();
    scriptedCheck({ value: true });
    let attempts = 0;
    const build = async (call: ImplementerOptions | RetryOptions) => {
      if (call.task.id === 'T000') write(call.projectDir, 'src/z.ts', 'T000 done\n');
      else if (attempts++ === 0) {
        write(call.projectDir, 'src/a.ts', 'attempt 1\n');
        write(call.projectDir, 'src/z.ts', 'T000 done + attempt 1 edit\n');
      } else write(call.projectDir, 'src/b.ts', 'rewrite\n');
      return { success: true, output: 'implemented' };
    };
    let consults = 0;
    const consult = consultCallAnswering(
      (): ConsultAnswer =>
        ++consults === 1
          ? rewrite({ value: true }, false)
          : {
              answer: {
                diagnosis: 'The rewrite does not help.',
                action: 'cannot',
                reason: 'The module cannot be finished.',
                next: 'skip-brief',
              },
            },
    );
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx({
      ...ref,
      bus,
      config: makeNoValidationConfig({ workflow: { isolation: 'none', review: 'end' } }),
      planner: makePlanner({ typedCall: consult }),
      implementer: makeImplementer({ implement: vi.fn(build), retry: vi.fn(build) }),
    });
    const result = await runTaskLoop({
      wctx,
      initialState: makeImplState([
        makeTask({ id: 'T000', suggestedFiles: ['src/z.ts'], criteria: [], checks: [] }),
        makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], criteria: [], checks: [CHECK] }),
      ]),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
    expect(result.state.pendingRecovery?.reason).toBe('retry-exhausted');
    expect(read(ref, 'src/z.ts')).toBe('T000 done + attempt 1 edit\n');
    expect(present(ref, ['src/a.ts', 'src/b.ts'])).toEqual(['src/a.ts']);
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');

    const skipped = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'skip-current-task',
      bus,
    });

    expect(skipped.ok).toBe(true);
    expect(read(ref, 'src/z.ts')).toBe('T000 done\n');
    expect(present(ref, ['src/a.ts', 'src/b.ts'])).toEqual([]);
    expect(booked(ref).byTask).toEqual({ T000: ['src/z.ts'], T001: [] });
    expect(warnings(events).at(-1)).toMatch(
      /Restored 2 changes of the attempts before the rewrite or split: src\/a\.ts, src\/z\.ts/,
    );
  });

  it('takes back the lineage files but keeps the done child result when the user skips the last split child', async () => {
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
          write(opts.projectDir, 'src/a.ts', 'export const a = 3;\n');
        }
      },
    });
    expect(result.state.pendingRecovery?.reason).toBe('planner-call-failed');
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');

    const skipped = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'skip-current-task',
      bus,
    });

    expect(skipped.ok).toBe(true);
    expect(read(ref, 'src/a.ts')).toBe('export const a = 1;\n');
    expect(read(ref, 'src/c.ts')).toBe('export const c = 1;\n');
    expect(present(ref, ['gen/x.txt', 'src/b.ts', 'src/retry.ts'])).toEqual([]);
    expect(booked(ref).byTask).toEqual({
      T001: [],
      T002: ['src/a.ts', 'src/c.ts'],
      T003: [],
    });
  });

  it('keeps the result of a fix brief that ran between the split children when the user skips the last child', async () => {
    let reviews = 0;
    let check = { value: false };
    const { ref, result, bus } = await runLineage({
      answers: [
        (failing) => {
          check = failing;
          return split(failing, { secondChecks: [CHECK] });
        },
      ],
      afterConsult: (_call, opts) => {
        if (opts.task.fix !== undefined)
          write(opts.projectDir, 'src/c.ts', 'export const c = 1;\n');
        if (opts.task.id === 'T003') {
          check.value = true;
          write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n');
        }
      },
      review: (prompt) =>
        reviews++ === 0
          ? failedReviewVerdict(prompt, 'src/c.ts is missing', {
              taskId: taskId('T002'),
              file: 'src/c.ts',
            })
          : undefined,
      preSplitFiles: ['src/c.ts'],
    });
    expect(result.state.pendingRecovery?.reason).toBe('planner-call-failed');
    expect(result.state.tasks.map((task) => [task.id, task.status])).toEqual([
      ['T002', 'done'],
      ['T004', 'done'],
      ['T003', 'in_progress'],
    ]);
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');

    const skipped = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'skip-current-task',
      bus,
    });

    expect(skipped.ok).toBe(true);
    expect(read(ref, 'src/c.ts')).toBe('export const c = 1;\n');
    expect(present(ref, ['gen/x.txt', 'src/b.ts', 'src/retry.ts'])).toEqual([]);
    expect(booked(ref).byTask.T004).toEqual(['src/c.ts']);
  });

  it('keeps an edit the user made at the boundary between the split children when the user skips the last child', async () => {
    let check = { value: false };
    const { ref, result, bus } = await runLineage({
      answers: [
        (failing) => {
          check = failing;
          return split(failing, { secondChecks: [CHECK] });
        },
      ],
      afterConsult: (_call, opts) => {
        if (opts.task.id === 'T003') {
          check.value = true;
          write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n');
        }
      },
      pauseAfter: 'T002',
      atPause: (projectDir) => write(projectDir, 'src/user.ts', 'export const user = 1;\n'),
    });
    expect(result.state.pendingRecovery?.reason).toBe('planner-call-failed');
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');

    const skipped = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'skip-current-task',
      bus,
    });

    expect(skipped.ok).toBe(true);
    expect(read(ref, 'src/user.ts')).toBe('export const user = 1;\n');
    expect(present(ref, ['gen/x.txt', 'src/b.ts', 'src/retry.ts'])).toEqual([]);
  });

  it('keeps the lineage files for the open sibling when the user skips the first split child', async () => {
    let check = { value: false };
    const { ref, result, bus } = await runLineage({
      answers: [
        (failing) => {
          check = failing;
          return split(failing, { firstChecks: [CHECK] });
        },
      ],
      afterConsult: (_call, opts) => {
        if (opts.task.id === 'T002') {
          check.value = true;
          write(opts.projectDir, 'src/d.ts', 'export const d = 1;\n');
        }
      },
    });
    expect(result.state.pendingRecovery?.reason).toBe('planner-call-failed');
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');

    const skipped = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'skip-current-task',
      bus,
    });

    expect(skipped.ok).toBe(true);
    expect(skipped.state.tasks.map((task) => [task.id, task.status])).toEqual([
      ['T002', 'skipped'],
      ['T003', 'pending'],
    ]);
    expect(present(ref, ['src/d.ts', ...LINEAGE_FILES])).toEqual([
      'gen/x.txt',
      'src/a.ts',
      'src/retry.ts',
    ]);
  });

  it('books no taken-back file when the user skips both split children', async () => {
    let check = { value: false };
    const { ref, wctx, result, bus } = await runLineage({
      answers: [
        (failing) => {
          check = failing;
          return split(failing, { firstChecks: [CHECK] });
        },
      ],
      afterConsult: (_call, opts) => {
        if (opts.task.id === 'T002') {
          check.value = true;
          write(opts.projectDir, 'src/a.ts', 'export const a = 2;\n');
        }
      },
    });
    expect(result.state.pendingRecovery?.reason).toBe('planner-call-failed');
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');
    const first = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'skip-current-task',
      bus,
    });
    expect(first.ok).toBe(true);
    const blocked = await runTaskLoop({
      wctx,
      initialState: first.state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
    expect(blocked.state.pendingRecovery?.reason).toBe('dependency-blocked');
    expect(blocked.state.pendingRecovery?.availableActions).toEqual([
      'skip-current-task',
      'end-run',
    ]);
    const second = loadState(ref);
    if (second === null) throw new Error('Missing blocked state');

    const skipped = await applyRecoveryAction({
      ...ref,
      state: second,
      action: 'skip-current-task',
      bus,
    });

    expect(skipped.ok).toBe(true);
    expect(present(ref, LINEAGE_FILES)).toEqual([]);
    expect(booked(ref).byTask).toEqual({ T001: [], T002: [], T003: [] });
    expect(reviewed(ref)).toEqual([]);
    const closed = loadState(ref);
    if (closed === null) throw new Error('Missing skipped state');
    const summary = buildSummary({
      ...ref,
      feature: 'f',
      state: closed,
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'codex',
    });
    expect(summary.changedFiles).toEqual([]);
  });

  it('books the kept files of a skipped split child once when the user ends the run at the blocked child', async () => {
    let check = { value: false };
    const { ref, wctx, result, bus } = await runLineage({
      answers: [
        (failing) => {
          check = failing;
          return split(failing, { firstChecks: [CHECK] });
        },
      ],
      afterConsult: (_call, opts) => {
        if (opts.task.id === 'T002') {
          check.value = true;
          write(opts.projectDir, 'src/a.ts', 'export const a = 2;\n');
        }
      },
    });
    expect(result.state.pendingRecovery?.reason).toBe('planner-call-failed');
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');
    const first = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'skip-current-task',
      bus,
    });
    expect(first.ok).toBe(true);
    const blocked = await runTaskLoop({
      wctx,
      initialState: first.state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
    expect(blocked.state.pendingRecovery?.reason).toBe('dependency-blocked');
    const second = loadState(ref);
    if (second === null) throw new Error('Missing blocked state');
    const checkoutRun = {
      ...second,
      workspace: {
        kind: 'checkout' as const,
        path: ref.projectDir,
        base: { snapshotId: 'base', head: null },
      },
    };
    saveState(ref, checkoutRun);

    const ended = await applyRecoveryAction({ ...ref, state: checkoutRun, action: 'end-run', bus });

    expect(ended.ok).toBe(true);
    expect(read(ref, 'src/a.ts')).toBe('export const a = 1;\n');
    expect(booked(ref).byTask).toEqual({
      T001: [],
      T002: ['gen/x.txt', 'src/a.ts', 'src/retry.ts'],
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
    expect(summary.changedFiles).toEqual(['gen/x.txt', 'src/a.ts', 'src/retry.ts']);
  });

  it('books the files of a skipped split child on the child that closes the lineage', async () => {
    let check = { value: false };
    const { ref, wctx, result, bus } = await runLineage({
      answers: [
        (failing) => {
          check = failing;
          return split(failing, { firstChecks: [CHECK], independent: true });
        },
      ],
      afterConsult: (_call, opts) => {
        if (opts.task.id === 'T002') {
          check.value = true;
          write(opts.projectDir, 'src/a.ts', 'export const a = 2;\n');
        }
        if (opts.task.id === 'T003') {
          check.value = false;
          write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n');
        }
      },
    });
    expect(result.state.pendingRecovery?.reason).toBe('planner-call-failed');
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');
    const skipped = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'skip-current-task',
      bus,
    });
    expect(skipped.ok).toBe(true);

    const finished = await runTaskLoop({
      wctx,
      initialState: skipped.state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(finished.status).toBe('complete');
    expect(read(ref, 'src/a.ts')).toBe('export const a = 1;\n');
    expect(booked(ref).byTask).toEqual({
      T001: [],
      T002: [],
      T003: ['gen/x.txt', 'src/a.ts', 'src/b.ts', 'src/retry.ts'],
    });
    expect(reviewed(ref, 'T002')).toEqual([]);
  });

  it('keeps the replaced attempts when a rewritten brief restarts after an interruption', async () => {
    const { ref, result, bus } = await runLineage({
      answers: [(failing) => rewrite(failing, false)],
      afterConsult: (_call, opts) => write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n'),
    });
    expect(result.state.pendingRecovery?.reason).toBe('planner-call-failed');
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');
    const task = halted.tasks[halted.currentTaskIndex];
    const taskStartSnapshot = halted.changedFilesBaseline?.activeTaskSnapshot;
    if (task === undefined || taskStartSnapshot === undefined)
      throw new Error('Missing the rewritten brief or its task start');
    // The killed run had written its own file again.
    write(ref.projectDir, 'src/b.ts', 'export const b = 2;\n');

    await restoreInterruptedTaskFiles({
      wctx: { ...ref, workspaceDir: ref.projectDir, bus },
      phase: halted.phase,
      task,
      taskStartSnapshot,
    });

    expect(present(ref, LINEAGE_FILES)).toEqual(['gen/x.txt', 'src/a.ts', 'src/retry.ts']);
  });

  it('books the replaced attempts on a rewritten brief when the user ends the run inside it', async () => {
    const { ref, result, bus } = await runLineage({
      answers: [(failing) => rewrite(failing, false)],
      afterConsult: (_call, opts) => write(opts.projectDir, 'src/b.ts', 'export const b = 1;\n'),
    });
    expect(result.state.pendingRecovery?.reason).toBe('planner-call-failed');
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
    // The halt kept src/b.ts, the rewritten brief's own file, so the brief books it.
    expect(booked(ref).byTask).toEqual({
      T001: ['gen/x.txt', 'src/a.ts', 'src/b.ts', 'src/retry.ts'],
    });
  });

  it('gives a done child its file back when the user skips a rewritten later child that edited it', async () => {
    const { ref, result, bus } = await runChildRewrite({ rev2: () => {}, last: cannot });
    expect(result.state.pendingRecovery?.reason).toBe('retry-exhausted');
    // The halt keeps the first revision's edit, so Try again continues on it.
    expect(read(ref, 'src/a.ts')).toBe('export const a = 3;\n');
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');

    const skipped = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'skip-current-task',
      bus,
    });

    expect(skipped.ok).toBe(true);
    expect(read(ref, 'src/a.ts')).toBe('export const a = 2;\n');
    expect(present(ref, LINEAGE_FILES)).toEqual(['src/a.ts']);
    expect(booked(ref).byTask).toEqual({ T001: [], T002: ['src/a.ts'], T003: [] });
  });

  it('books no file on a skipped rewritten child whose second revision wrote the file again', async () => {
    const { ref, result, bus } = await runChildRewrite({
      rev2: (projectDir) => write(projectDir, 'src/b.ts', 'export const b = 4;\n'),
    });
    expect(result.state.pendingRecovery?.reason).toBe('planner-call-failed');
    // The halt keeps the second revision's write; Skip takes it back.
    expect(read(ref, 'src/b.ts')).toBe('export const b = 4;\n');
    const halted = loadState(ref);
    if (halted === null) throw new Error('Missing halted state');

    const skipped = await applyRecoveryAction({
      ...ref,
      state: halted,
      action: 'skip-current-task',
      bus,
    });

    expect(skipped.ok).toBe(true);
    expect(present(ref, LINEAGE_FILES)).toEqual(['src/a.ts']);
    expect(booked(ref).byTask).toEqual({ T001: [], T002: ['src/a.ts'], T003: [] });
    const closed = loadState(ref);
    if (closed === null) throw new Error('Missing skipped state');
    const summary = buildSummary({
      ...ref,
      feature: 'f',
      state: closed,
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'codex',
    });
    expect(summary.changedFiles).toEqual(['src/a.ts']);
  });

  it('gives a done child its file back when a pre_validation hook denies a rewritten later child', async () => {
    const trust = useTrustHome('lineage-booking-trust-home');
    // The hook and its marker live outside the project: a file there before the run fails the review.
    const deny = join(trust.home, 'deny');
    const hook = join(trust.home, 'deny-on-marker.mjs');
    try {
      const { ref, result } = await runChildRewrite({
        rev2: (projectDir) => {
          write(projectDir, 'src/b.ts', 'export const b = 4;\n');
          writeFileSync(deny, '');
        },
        hooks: () => {
          writeFileSync(
            hook,
            [
              "import { existsSync } from 'node:fs';",
              `if (existsSync(${JSON.stringify(deny)})) console.log(JSON.stringify({ decision: 'deny', message: 'policy' }));`,
              '',
            ].join('\n'),
          );
          return {
            pre_validation: [
              {
                kind: 'command',
                command: 'node',
                args: [hook],
                timeout_ms: 30_000,
                on_failure: 'warn',
              },
            ],
          };
        },
      });

      expect(result.state.tasks.map((task) => [task.id, task.status])).toEqual([
        ['T002', 'done'],
        ['T003', 'skipped'],
      ]);
      expect(read(ref, 'src/a.ts')).toBe('export const a = 2;\n');
      expect(present(ref, LINEAGE_FILES)).toEqual(['src/a.ts']);
      expect(booked(ref).byTask).toEqual({ T001: [], T002: ['src/a.ts'], T003: [] });
    } finally {
      trust.restore();
    }
  });
});

function rewriteSecondChild(): ConsultAnswer {
  return {
    answer: {
      diagnosis: 'The second half asks for the wrong thing.',
      action: 'rewrite-task',
      task: makeTaskSpec({
        id: 'T003',
        title: 'Second half again',
        criteria: [],
        checks: [CHECK],
        suggestedFiles: ['src/b.ts'],
      }),
    },
  };
}

function cannot(): ConsultAnswer {
  return {
    answer: {
      diagnosis: 'The rewrite does not help.',
      action: 'cannot',
      reason: 'The module cannot be finished.',
      next: 'skip-brief',
    },
  };
}

/**
 * T001 splits into T002 (`src/a.ts`) and T003 (`src/b.ts`, a failing check). T002 writes
 * `src/a.ts` and is done. T003's first revision also edits `src/a.ts`, writes `src/b.ts` and
 * fails; the planner rewrites T003, its second revision runs `rev2` and fails, and the planner
 * answers `last` when given.
 */
function runChildRewrite(opts: {
  rev2: (projectDir: string) => void;
  last?: () => ConsultAnswer;
  hooks?: (projectDir: string) => HooksConfig;
}) {
  let check = { value: false };
  return runLineage({
    answers: [
      (failing) => {
        check = failing;
        return split(failing, { secondChecks: [CHECK] });
      },
      rewriteSecondChild,
      ...(opts.last === undefined ? [] : [opts.last]),
    ],
    afterConsult: (_call, call) => {
      if (call.task.id === 'T002') write(call.projectDir, 'src/a.ts', 'export const a = 2;\n');
      if (call.task.id !== 'T003') return;
      check.value = true;
      if ((call.task.revision ?? 1) > 1) return opts.rev2(call.projectDir);
      write(call.projectDir, 'src/a.ts', 'export const a = 3;\n');
      write(call.projectDir, 'src/b.ts', 'export const b = 3;\n');
    },
    ...(opts.hooks !== undefined && { hooks: opts.hooks }),
  });
}
