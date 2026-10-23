import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeCopyingIsolation,
  makeCallbacks,
  makeBusRecorder,
  makeImplementer,
  makePlanner,
  makeWctx,
  openRunWorkspace,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { consultCallAnswering } from '#testing/helpers/typed-planner.js';
import type { ConsultAnswer } from '../../../core/schemas/consult.js';
import type { ImplementerOptions, RetryOptions } from '../../implementers/types.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { runTaskLoop } from './loop.js';
import { BOUNDS } from '../../../core/pipeline-spec/bounds.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { mutateEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';

let dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'task-loop-consult',
    sessionId: 'sess-loop-consult',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

async function haltCheckoutBrief() {
  const ref = setupProject();
  const task = makeTask({
    suggestedFiles: ['src/attempt.ts', 'src/later.ts'],
    checks: [{ id: 'check', kind: 'cmd', value: 'tsc --noEmit', required: true }],
  });
  const writeAttempt = async (opts: ImplementerOptions) => {
    mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
    writeFileSync(join(opts.projectDir, 'src/attempt.ts'), 'failed attempt\n');
    writeFileSync(join(opts.projectDir, 'src/earlier.ts'), 'earlier attempt\n');
    return { success: true, output: 'implemented' };
  };
  let checks = 0;
  vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
    writeFileSync(join(ref.projectDir, `generated-${++checks}.txt`), 'failed check output\n');
    throw processError.exitCode({ command: 'tsc', code: 2, stderr: 'check failed', output: '' });
  });
  const { bus, events } = makeBusRecorder();
  const wctx = makeWctx({
    ...ref,
    bus,
    config: makeNoValidationConfig({ workflow: { isolation: 'none', review: 'task' } }),
    planner: makePlanner({
      typedCall: consultCallAnswering(() => ({
        answer: {
          diagnosis: 'The check failed.',
          action: 'guidance',
          instructions: 'Repair the brief.',
          context: null,
        },
      })),
    }),
    implementer: makeImplementer({ implement: vi.fn(writeAttempt), retry: vi.fn(writeAttempt) }),
  });
  const halted = await runTaskLoop({
    wctx,
    initialState: {
      ...makeImplState([task]),
      plannerCalls: { used: BOUNDS.plannerCallsPerRun, allowance: BOUNDS.plannerCallsPerRun },
    },
    setTrackedState: vi.fn(),
    setCurrentTask: vi.fn(),
  });
  expect(halted.state.pendingRecovery?.reason).toBe('planner-calls-spent');
  return {
    ref,
    wctx,
    halted,
    bus,
    events,
    generatedFiles: () =>
      Array.from({ length: checks }, (_, index) => `generated-${index + 1}.txt`),
  };
}

/** The split answer: two subtasks that together keep T002's only criterion. */
function splitIntoTwo(): ConsultAnswer {
  return {
    answer: {
      diagnosis: 'T002 carries two jobs; split it so each half can pass alone.',
      action: 'split-task',
      tasks: [
        makeTaskSpec({
          id: 'T100',
          title: 'First half of T002',
          intent: 'Do the first half of the work T002 carried.',
          criteria: ['C2'],
          checks: [],
          suggestedFiles: ['src/b.ts'],
        }),
        makeTaskSpec({
          id: 'T101',
          title: 'Second half of T002',
          intent: 'Do the second half of the work T002 carried.',
          criteria: ['C2'],
          checks: [],
          suggestedFiles: ['src/c.ts'],
          dependsOn: ['T100'],
        }),
      ],
    },
  };
}

describe('runTaskLoop with a consult', { timeout: 90_000 }, () => {
  it.each(['skip', 'continue'] as const)(
    'preserves every older path with contaminated evidence after %s',
    async (action) => {
      const { ref, wctx, bus } = await haltCheckoutBrief();
      const persisted = loadState(ref);
      const baseline = persisted?.changedFilesBaseline;
      const snapshot = baseline?.activeTaskSnapshot;
      if (persisted === null || baseline === undefined || snapshot === undefined)
        throw new Error('Missing halted snapshot');
      const { restoreFiles: _restoreFiles, ...olderSnapshot } = snapshot;
      saveState(ref, {
        ...persisted,
        changedFilesBaseline: { ...baseline, activeTaskSnapshot: olderSnapshot },
      });
      writeFileSync(join(ref.projectDir, 'init.txt'), 'edited while halted\n');
      writeFileSync(join(ref.projectDir, 'scratch.txt'), 'notes while halted\n');
      writeFileSync(join(ref.projectDir, 'src/attempt.ts'), 'user source edit\n');
      mutateEvidenceLedger(ref, (ledger) => {
        if (ledger === null) throw new Error('Missing halted evidence');
        return {
          ...ledger,
          tasks: ledger.tasks.map((entry) => ({
            ...entry,
            changedFiles: [...entry.changedFiles, 'init.txt', 'scratch.txt'],
          })),
        };
      });

      if (action === 'continue') {
        const continued = await applyRecoveryAction({
          ...ref,
          state: loadState(ref) ?? persisted,
          action: 'continue',
          comment: plainUserMessage('Try the brief again.'),
          bus,
          config: wctx.config,
        });
        expect(continued.ok).toBe(true);
        const resumedState = loadState(ref);
        if (resumedState === null) throw new Error('Missing continued state');
        const writeLater = async (opts: ImplementerOptions) => {
          writeFileSync(join(opts.projectDir, 'src/later.ts'), 'continued attempt\n');
          return { success: true, output: 'implemented' };
        };
        const resumed = await runTaskLoop({
          wctx: {
            ...wctx,
            implementer: makeImplementer({
              implement: vi.fn(writeLater),
              retry: vi.fn(writeLater),
            }),
          },
          initialState: resumedState,
          setTrackedState: vi.fn(),
          setCurrentTask: vi.fn(),
        });
        expect(resumed.state.pendingRecovery?.reason).toBe('consult-bound-spent');
      }

      const skipped = await applyRecoveryAction({
        ...ref,
        state: loadState(ref) ?? persisted,
        action: 'skip-current-task',
        bus,
      });
      expect(skipped.ok).toBe(true);
      expect(readFileSync(join(ref.projectDir, 'src/attempt.ts'), 'utf8')).toBe(
        'user source edit\n',
      );
      expect(readFileSync(join(ref.projectDir, 'src/earlier.ts'), 'utf8')).toBe(
        'earlier attempt\n',
      );
      expect(existsSync(join(ref.projectDir, 'src/later.ts'))).toBe(false);
      expect(readFileSync(join(ref.projectDir, 'init.txt'), 'utf8')).toBe('edited while halted\n');
      expect(readFileSync(join(ref.projectDir, 'scratch.txt'), 'utf8')).toBe(
        'notes while halted\n',
      );
    },
  );

  it('removes output from failing checks when the halted brief is skipped', async () => {
    const { ref, bus, generatedFiles } = await haltCheckoutBrief();
    const persisted = loadState(ref);
    if (persisted === null) throw new Error('Missing halted state');
    expect(generatedFiles().length).toBeGreaterThan(1);
    for (const file of generatedFiles()) expect(existsSync(join(ref.projectDir, file))).toBe(true);
    writeFileSync(join(ref.projectDir, 'scratch.txt'), 'notes while halted\n');

    const skipped = await applyRecoveryAction({
      ...ref,
      state: persisted,
      action: 'skip-current-task',
      bus,
    });

    expect(skipped.ok).toBe(true);
    for (const file of generatedFiles()) expect(existsSync(join(ref.projectDir, file))).toBe(false);
    expect(readFileSync(join(ref.projectDir, 'scratch.txt'), 'utf8')).toBe('notes while halted\n');
  });

  it.each(['skip', 'planner failure'] as const)(
    'restores output from consult verification after %s',
    async (action) => {
      const ref = setupProject();
      const task = makeTask({
        suggestedFiles: ['src/attempt.ts'],
        checks: [{ id: 'check', kind: 'cmd', value: 'node --version', required: true }],
      });
      let checks = 0;
      vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
        writeFileSync(join(ref.projectDir, `generated-${++checks}.txt`), 'check output\n');
        throw processError.exitCode({ command: 'node', code: 1, stderr: 'check failed' });
      });
      const writeAttempt = async (opts: ImplementerOptions) => {
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, 'src/attempt.ts'), 'attempt edit\n');
        return { success: true, output: 'implemented' };
      };
      const { bus } = makeBusRecorder();
      let consults = 0;
      const wctx = makeWctx({
        ...ref,
        bus,
        config: makeNoValidationConfig({ workflow: { isolation: 'none', review: 'task' } }),
        implementer: makeImplementer({
          implement: vi.fn(writeAttempt),
          retry: vi.fn(writeAttempt),
        }),
        planner: makePlanner({
          typedCall: consultCallAnswering(() => {
            if (action === 'planner failure' && ++consults > 1)
              throw new Error('Planner call failed');
            return {
              answer: {
                diagnosis: 'The check needs verification.',
                action: 'verify',
                checkIds: ['check'],
                reason: 'Run the check again.',
              },
            };
          }),
        }),
      });

      const halted = await runTaskLoop({
        wctx,
        initialState: makeImplState([task]),
        setTrackedState: vi.fn(),
        setCurrentTask: vi.fn(),
      });

      expect(halted.state.pendingRecovery?.reason).toBe(
        action === 'skip' ? 'consult-bound-spent' : 'planner-call-failed',
      );
      expect(checks).toBeGreaterThan(2);
      const persisted = loadState(ref);
      if (persisted === null) throw new Error('Missing halted verification state');
      writeFileSync(join(ref.projectDir, 'init.txt'), 'user edit while halted\n');
      if (action === 'skip') {
        const skipped = await applyRecoveryAction({
          ...ref,
          state: persisted,
          action: 'skip-current-task',
          bus,
        });
        expect(skipped.ok).toBe(true);
      }
      expect(existsSync(join(ref.projectDir, 'src/attempt.ts'))).toBe(false);
      for (let index = 1; index <= checks; index++)
        expect(existsSync(join(ref.projectDir, `generated-${index}.txt`))).toBe(false);
      expect(readFileSync(join(ref.projectDir, 'init.txt'), 'utf8')).toBe(
        'user edit while halted\n',
      );
    },
  );

  it.each(['failure', 'pre-validation denial'] as const)(
    'limits automatic rollback after continuation through %s to attempt writes',
    async (outcome) => {
      const { ref, wctx, halted, bus, events, generatedFiles } = await haltCheckoutBrief();
      writeFileSync(join(ref.projectDir, 'init.txt'), 'edited while halted\n');
      writeFileSync(join(ref.projectDir, 'scratch.txt'), 'notes while halted\n');
      const continued = await applyRecoveryAction({
        ...ref,
        state: halted.state,
        action: 'continue',
        comment: plainUserMessage('Try the brief again.'),
        bus,
        config: wctx.config,
      });
      expect(continued.ok).toBe(true);
      const resumedState = loadState(ref);
      if (resumedState === null) throw new Error('Missing continued state');
      const trustHome = useTrustHome('continued-validation');
      const hooks: HooksConfig =
        outcome === 'pre-validation denial'
          ? {
              pre_validation: [
                {
                  kind: 'command',
                  command: 'node',
                  args: ['deny-validation.mjs'],
                  timeout_ms: 30_000,
                  on_failure: 'block',
                },
              ],
            }
          : {};
      writeFileSync(
        join(ref.projectDir, 'deny-validation.mjs'),
        "import { writeFileSync } from 'node:fs';\nwriteFileSync('hook-output.txt', 'hook output');\nconsole.log(JSON.stringify({ decision: 'deny', message: 'validation denied' }));\n",
      );
      markHooksConfigTrusted(ref.projectDir, hooks);
      const writeLater = async (opts: ImplementerOptions) => {
        writeFileSync(join(opts.projectDir, 'src/later.ts'), 'continued attempt\n');
        return { success: true, output: 'implemented' };
      };
      let resumed: Awaited<ReturnType<typeof runTaskLoop>>;
      try {
        resumed = await runTaskLoop({
          wctx: {
            ...wctx,
            config: {
              ...wctx.config,
              hooks,
            },
            implementer: makeImplementer({
              implement: vi.fn(writeLater),
              retry: vi
                .fn()
                .mockImplementationOnce(writeLater)
                .mockRejectedValue(new Error('retry failed')),
            }),
          },
          initialState: resumedState,
          setTrackedState: vi.fn(),
          setCurrentTask: vi.fn(),
        });
      } finally {
        trustHome.restore();
      }
      expect(resumed.state.pendingRecovery?.reason).toBe(
        outcome === 'failure' ? 'retry-exhausted' : undefined,
      );
      if (outcome === 'pre-validation denial') {
        expect(resumed.state.tasks[0]?.status).toBe('skipped');
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'warning',
            message: 'pre_validation blocked: validation denied',
          }),
        );
      }
      expect(existsSync(join(ref.projectDir, 'src/attempt.ts'))).toBe(false);
      expect(existsSync(join(ref.projectDir, 'src/earlier.ts'))).toBe(false);
      expect(existsSync(join(ref.projectDir, 'src/later.ts'))).toBe(false);
      for (const file of generatedFiles())
        expect(existsSync(join(ref.projectDir, file))).toBe(false);
      expect(existsSync(join(ref.projectDir, 'hook-output.txt'))).toBe(false);
      expect(readFileSync(join(ref.projectDir, 'init.txt'), 'utf8')).toBe('edited while halted\n');
      expect(readFileSync(join(ref.projectDir, 'scratch.txt'), 'utf8')).toBe(
        'notes while halted\n',
      );
    },
  );

  it('preserves unrelated edits made during an inline stop when a later halt is skipped', async () => {
    const ref = setupProject();
    const task = makeTask({
      suggestedFiles: ['src/attempt.ts'],
      checks: [{ id: 'check', kind: 'cmd', value: 'tsc --noEmit', required: true }],
    });
    const state = {
      ...makeImplState([task]),
      plannerCalls: { used: BOUNDS.plannerCallsPerRun, allowance: BOUNDS.plannerCallsPerRun },
    };
    const writeAttempt = async (opts: ImplementerOptions) => {
      mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
      writeFileSync(join(opts.projectDir, 'src/attempt.ts'), 'failed attempt\n');
      return { success: true, output: 'implemented' };
    };
    vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
      processError.exitCode({ command: 'tsc', code: 2, stderr: 'check failed', output: '' }),
    );
    const { bus } = makeBusRecorder();
    const wctx = makeWctx({
      ...ref,
      bus,
      config: makeNoValidationConfig({ workflow: { isolation: 'none', review: 'task' } }),
      implementer: makeImplementer({ implement: vi.fn(writeAttempt), retry: vi.fn(writeAttempt) }),
      callbacks: makeCallbacks({
        onContinuationNeeded: async () => {
          expect(loadState(ref)?.interruptedStep?.cut).toBe('mid-step');
          writeFileSync(join(ref.projectDir, 'init.txt'), 'edited while stopped\n');
          writeFileSync(join(ref.projectDir, 'scratch.txt'), 'notes while stopped\n');
          return plainUserMessage('Continue the brief.');
        },
      }).callbacks,
    });
    wctx.sinks = {
      ...wctx.sinks,
      consumeBoundaryInterrupt: vi.fn().mockReturnValueOnce(true).mockReturnValue(false),
    };
    const halted = await runTaskLoop({
      wctx,
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
    expect(halted.state.pendingRecovery?.reason).toBe('planner-calls-spent');
    const persisted = loadState(ref);
    if (persisted === null) throw new Error('Missing halted state');

    const skipped = await applyRecoveryAction({
      ...ref,
      state: persisted,
      action: 'skip-current-task',
      bus,
    });

    expect(skipped.ok).toBe(true);
    expect(existsSync(join(ref.projectDir, 'src/attempt.ts'))).toBe(false);
    expect(readFileSync(join(ref.projectDir, 'init.txt'), 'utf8')).toBe('edited while stopped\n');
    expect(readFileSync(join(ref.projectDir, 'scratch.txt'), 'utf8')).toBe('notes while stopped\n');
  });

  it('repairs a twice-failing task by splitting it, with no user prompt, and keeps earlier work', async () => {
    const { projectDir, sessionId } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], criteria: ['C1'] }),
      makeTask({
        id: 'T002',
        suggestedFiles: ['src/b.ts'],
        criteria: ['C2'],
        checks: [{ id: 'K2', kind: 'cmd', value: 'tsc --noEmit', required: true }],
      }),
      makeTask({
        id: 'T003',
        suggestedFiles: ['src/final.ts'],
        criteria: ['C3'],
        dependsOn: ['T002'],
      }),
    ];
    const state = makeImplState(tasks);

    // T002's first attempt and its retry leave a new file behind; the retry also
    // overwrites the file T001 completed, so the split's rollback has to put it back.
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(
          join(opts.projectDir, opts.task.suggestedFiles[0]),
          `done by ${opts.task.id}\n`,
        );
        return {
          success: true,
          output: 'wrote the brief file',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }),
      retry: vi.fn().mockImplementation(async (opts: RetryOptions) => {
        if (opts.kind === 'local' && opts.task.id === 'T002') {
          writeFileSync(join(opts.projectDir, 'src/a.ts'), 'broken by the T002 retry\n');
          writeFileSync(join(opts.projectDir, 'src/c.ts'), 'left by the T002 retry\n');
        }
        return {
          success: true,
          output: 'retried the brief',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }),
    });

    // Only T002 carries a check, and it stays red; every other brief passes.
    vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
      processError.exitCode({
        command: 'tsc',
        code: 2,
        stderr: 'T002 is not finished',
        output: '',
      }),
    );

    const { callbacks } = makeCallbacks({ onPlannerReply: vi.fn() });
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({ typedCall: consultCallAnswering(() => splitIntoTwo()) });

    const wctx = await openRunWorkspace(
      makeWctx({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: makeNoValidationConfig({ workflow: { review: 'task' } }),
        callbacks,
        planner,
        implementer,
        bus,
      }),
    );
    const result = await runTaskLoop({
      wctx,
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    // No planner reply or question reached the operator, and the run did not halt.
    expect(callbacks.onPlannerReply).not.toHaveBeenCalled();
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.status).toBe('complete');

    // The parent is gone from the task list; its record keeps it in the lineage.
    const byId = new Map(result.state.tasks.map((task) => [task.id, task]));
    expect(byId.has(taskId('T002'))).toBe(false);
    expect(result.state.lineages?.T002?.replacedParents.map((task) => task.id)).toEqual(['T002']);

    // The split's children replaced the parent in answer order and share its lineage.
    expect(byId.get(taskId('T004'))).toMatchObject({ status: 'done', parentId: 'T002' });
    expect(byId.get(taskId('T005'))).toMatchObject({ status: 'done', parentId: 'T002' });
    expect(byId.get(taskId('T003'))?.dependsOn).toEqual(['T004', 'T005']);
    expect(byId.get(taskId('T003'))?.status).toBe('done');

    // Two implementer attempts on T002, one consult on its lineage.
    expect(result.state.lineages?.T002).toMatchObject({ attempts: 2, consults: 1 });

    // T001's work survived the failed retry and the split's rollback, in the run
    // workspace; the checkout never received any of it.
    expect(readFileSync(join(wctx.workspaceDir, 'src/a.ts'), 'utf-8')).toBe('done by T001\n');
    expect(existsSync(join(projectDir, 'src/a.ts'))).toBe(false);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'consult_answered',
        taskId: 'T002',
        reason: 'failed',
        action: 'split-task',
        newTaskIds: ['T004', 'T005'],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tasks_inserted',
        parentId: 'T002',
        taskIds: ['T004', 'T005'],
      }),
    );
  });

  it('reviews a split child that a consult verified before its sibling starts', async () => {
    const { projectDir, sessionId } = setupProject();
    const check = { id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true } as const;
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'], criteria: ['C1'], checks: [check] }),
    ];
    let green = false;
    vi.spyOn(commandRunner, 'runCommand').mockImplementation(async () => {
      if (green) return { stdout: '', stderr: '', code: 0 };
      throw processError.exitCode({ command: 'tsc', code: 2, stderr: 'not finished', output: '' });
    });
    const write = async (opts: ImplementerOptions) => {
      mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
      writeFileSync(join(opts.projectDir, opts.task.suggestedFiles[0]), `${opts.task.id}\n`);
      return { success: true, output: 'wrote the brief file' };
    };
    let consults = 0;
    const planner = makePlanner({
      typedCall: consultCallAnswering(() => {
        consults += 1;
        if (consults === 1) {
          return {
            answer: {
              diagnosis: 'T001 carries two jobs.',
              action: 'split-task',
              tasks: [
                makeTaskSpec({
                  id: 'T100',
                  criteria: ['C1'],
                  checks: [check],
                  suggestedFiles: ['src/b.ts'],
                }),
                makeTaskSpec({
                  id: 'T101',
                  criteria: ['C1'],
                  checks: [],
                  suggestedFiles: ['src/c.ts'],
                  dependsOn: ['T100'],
                }),
              ],
            },
          };
        }
        green = true;
        return {
          answer: {
            diagnosis: 'The check was flaky.',
            action: 'verify',
            checkIds: ['K1'],
            reason: 'Run the check again.',
          },
        };
      }),
    });
    const { bus, events } = makeBusRecorder();
    const wctx = await openRunWorkspace(
      makeWctx({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: makeNoValidationConfig({ workflow: { review: 'task' } }),
        planner,
        implementer: makeImplementer({ implement: vi.fn(write), retry: vi.fn(write) }),
        bus,
      }),
    );

    const result = await runTaskLoop({
      wctx,
      initialState: makeImplState(tasks),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'consult_answered', taskId: 'T002', action: 'verify' }),
    );
    const at = (match: (event: (typeof events)[number]) => boolean) => events.findIndex(match);
    const childDone = at((e) => e.type === 'task_completed' && e.taskId === 'T002');
    const review = at((e) => e.type === 'review_started');
    const siblingStart = at((e) => e.type === 'task_started' && e.taskId === 'T003');
    expect(childDone).toBeGreaterThanOrEqual(0);
    expect(review).toBeGreaterThan(childDone);
    expect(review).toBeLessThan(siblingStart);
  });
});
