import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withApplyRun, type ApplyRun } from '#testing/helpers/apply-run.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { planFromTasks, typedCallPlanAndReview } from '#testing/helpers/typed-planner.js';
import { createEvidenceLedger } from '../../core/evidence/ledger-state.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { runBaseTreesRoot } from '../../core/paths.js';
import type { Config } from '../../core/schemas/config.js';
import type { Task } from '../../core/schemas/task.js';
import { MAX_REVIEW_CHECKS, type ReviewChecksPlan } from '../../core/schemas/review.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { processError } from '../../lib/process/errors.js';
import { installDiagnosticSink } from '../../lib/warn.js';
import * as commandRunner from '../../lib/process/spawn/run-command.js';
import type { EngineEvent, EngineEventOf } from '../events/types.js';
import { recordLocalTaskEvidence } from './evidence/task.js';
import {
  REVIEW_CHECKS_SKIP_REASON,
  runReviewCheck,
  runReviewChecks,
  type ReviewChecksOptions,
  type ReviewChecksOutcome,
} from './review-checks.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const FILES = {
  'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
  'src/a.ts': 'export const a = 1;\n',
};
const NEW_RED = 'src/a.ts(1,14): error TS2322: Type number is not assignable to type string.';
const OLD_RED = 'src/legacy.ts(3,7): error TS2322: Type number is not assignable to type string.';

type CommandAnswer = 'pass' | { red: string; stderr?: string } | { throws: unknown };

/**
 * Runs the reviewer checks on a real run workspace and run base. `answer` decides each command by
 * its text and where it runs: the run workspace or the run base.
 */
async function reviewChecks(
  run: ApplyRun,
  opts: {
    plan: ReviewChecksPlan | ((prompt: string, call: number) => ReviewChecksPlan) | null;
    answer?: (command: string, at: 'workspace' | 'base') => CommandAnswer;
    config?: Config;
    tasks?: Task[];
    state?: Partial<WorkflowState>;
    /** False for an older run that recorded no workspace, and so no run base. */
    runBase?: boolean;
    scope?: 'final' | 'task';
    taskIds?: string[];
    changedFiles?: string[];
    onApproval?: ReviewChecksOptions['onApproval'];
    signal?: AbortSignal;
  },
) {
  const tasks = opts.tasks ?? [
    makeTask({ id: 'T001', status: 'done', suggestedFiles: ['src/a.ts'] }),
  ];
  const state: WorkflowState = makeImplState(tasks, {
    phase: 'final-review',
    ...(opts.runBase !== false && { workspace: run.workspace }),
    ...opts.state,
  });
  const ref = { projectDir: run.dir, sessionId: run.sessionId };
  saveState(ref, state);
  const commands: Array<{ command: string; at: 'workspace' | 'base' }> = [];
  vi.spyOn(commandRunner, 'runCommand').mockImplementation(async (cmd, args, options) => {
    const command = [cmd, ...args].join(' ');
    const at = options?.cwd === run.ws ? 'workspace' : 'base';
    commands.push({ command, at });
    const answer = opts.answer?.(command, at) ?? 'pass';
    if (answer === 'pass') return { stdout: 'ok', stderr: '', code: 0 };
    if ('throws' in answer) throw answer.throws;
    throw processError.exitCode({
      command,
      code: 1,
      stderr: answer.stderr ?? '',
      output: answer.red,
    });
  });
  const prompts: string[] = [];
  const checksCall = vi.fn((prompt: string) => {
    prompts.push(prompt);
    if (typeof opts.plan === 'function') return opts.plan(prompt, prompts.length);
    return opts.plan ?? { commands: [], declined: [], reason: null };
  });
  const reviewer = makePlanner({
    typedCall: typedCallPlanAndReview(
      () => planFromTasks(tasks),
      () => {
        throw new Error('the verdict call is not part of the reviewer checks');
      },
      undefined,
      checksCall,
    ),
  });
  const { bus, events } = makeBusRecorder();
  const outcome: ReviewChecksOutcome = await runReviewChecks({
    projectDir: run.dir,
    workspaceDir: run.ws,
    sessionId: run.sessionId,
    config: opts.config ?? makeConfig(),
    bus,
    state,
    reviewer,
    scope: opts.scope ?? 'final',
    taskIds: opts.taskIds ?? tasks.map((task) => task.id),
    changedFiles: opts.changedFiles ?? ['src/a.ts'],
    onApproval: opts.onApproval,
    signal: opts.signal,
  });
  return { outcome, events, commands, checksCall, prompts, ref };
}

function plan(commands: Array<[string, string]>): ReviewChecksPlan {
  return {
    commands: commands.map(([id, command]) => ({ id, command, reason: 'verifies the change' })),
    declined: [],
    reason: null,
  };
}

function rows(events: EngineEvent[]): EngineEventOf<'full_suite'>[] {
  return events.filter(
    (event): event is EngineEventOf<'full_suite'> => event.type === 'full_suite',
  );
}

function planned(events: EngineEvent[]): EngineEventOf<'review_checks'>[] {
  return events.filter(
    (event): event is EngineEventOf<'review_checks'> => event.type === 'review_checks',
  );
}

function sectionOf(outcome: ReviewChecksOutcome): string {
  if (outcome.kind !== 'ran') throw new Error(`expected the checks to run, got ${outcome.kind}`);
  return outcome.section;
}

describe('runReviewCheck at the brief gate', () => {
  it.each([
    {
      name: 'mixed compiler and test failures',
      output: `${NEW_RED}\n FAIL  src/b.test.ts > fails`,
      complete: true,
      ownLeft: 1,
      fresh: [NEW_RED],
    },
    {
      name: 'a carried compiler failure after character 4000',
      output: `${OLD_RED}\n${' '.repeat(4100)}\n${NEW_RED}`,
      complete: true,
      ownLeft: 1,
      fresh: [NEW_RED],
    },
    {
      name: 'an incomplete process capture',
      output: OLD_RED,
      complete: false,
      ownLeft: undefined,
      fresh: ['output over the capture limit'],
    },
    {
      name: 'a new stage-1 failure that skips stage 2',
      output: 'src/first.ts(1,1): error TS2322: New failure.',
      complete: true,
      ownLeft: 0,
      fresh: ['src/first.ts(1,1): error TS2322: New failure.'],
    },
    {
      name: 'a passing smoke row before a new compiler failure skips the carried test',
      output: `tests/test_smoke.py::test_ok PASSED [ 50%]\n${NEW_RED}`,
      complete: true,
      ownLeft: 0,
      fresh: [NEW_RED],
      carried: {
        failureKeys: ['tests/test_later.py::test_fails'],
        redKeys: ['tests/test_later.py::test_fails', 'tests/test_smoke.py::test_ok'],
      },
    },
  ])('rejects $name', async ({ output, complete, ownLeft, fresh, carried }) => {
    await withApplyRun(FILES, { sessionId: 'sess-brief-red' }, async (run) => {
      const { bus, events } = makeBusRecorder();
      vi.spyOn(commandRunner, 'runCommand').mockRejectedValue(
        processError.exitCode({
          command: 'npm test',
          code: 1,
          stderr: '',
          output,
          truncated: !complete,
        }),
      );
      const result = await runReviewCheck({
        check: { id: 'V1', command: 'npm test' },
        moment: 'brief',
        carried: carried ?? { failureKeys: [NEW_RED], redKeys: [NEW_RED, OLD_RED] },
        checkOptions: {
          projectDir: run.ws,
          config: makeConfig(),
          bus,
          phase: 'implementing',
          npmScriptsApproved: false,
          reviewChecks: [{ id: 'V1', kind: 'cmd', value: 'npm test', required: true }],
        },
      });
      expect(result.run.status).toBe('fail');
      expect([...result.fresh].sort()).toEqual([...fresh].sort());
      expect(rows(events).at(-1)).toMatchObject({ passed: false });
      if (ownLeft === undefined) expect(rows(events).at(-1)).not.toHaveProperty('own');
      else expect(rows(events).at(-1)).toMatchObject({ ownLeft });
      if (ownLeft === 0) expect(rows(events).at(-1)).toMatchObject({ proven: false });
      expect(commandRunner.runCommand).toHaveBeenCalledTimes(1);
    });
  });

  it('publishes the ownership verdict when the command passes', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-brief-green' }, async (run) => {
      const { bus, events } = makeBusRecorder();
      vi.spyOn(commandRunner, 'runCommand').mockResolvedValue({
        stdout: 'ok',
        stderr: '',
        code: 0,
      });
      const result = await runReviewCheck({
        check: { id: 'V1', command: 'npm test' },
        moment: 'brief',
        carried: { failureKeys: [NEW_RED], redKeys: [NEW_RED, OLD_RED] },
        checkOptions: {
          projectDir: run.ws,
          config: makeConfig(),
          bus,
          phase: 'implementing',
          npmScriptsApproved: false,
          reviewChecks: [{ id: 'V1', kind: 'cmd', value: 'npm test', required: true }],
        },
      });
      expect(result.fresh).toEqual([]);
      expect(rows(events).at(-1)).toMatchObject({
        passed: true,
        own: 1,
        ownLeft: 0,
        others: 0,
        proven: true,
      });
    });
  });
});

describe('runReviewChecks', { timeout: 60_000 }, () => {
  it('names the pending command and accepts its repair before running it first', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-fix-repair' }, async (run) => {
      const { outcome, prompts, checksCall, commands } = await reviewChecks(run, {
        state: { pendingReviewCommands: ['npm test'] },
        plan: (_prompt, call) =>
          call === 1
            ? plan([['V1', 'node --version']])
            : plan([
                ['V1', 'npm test'],
                ['V2', 'node --version'],
              ]),
      });

      expect(prompts[0]).toContain('## Commands a fix check ran\n\n- `npm test`');
      expect(prompts[1]).toContain('choose `npm test` among the first 1 commands');
      expect(checksCall).toHaveBeenCalledTimes(2);
      expect(outcome.kind).toBe('ran');
      expect(commands[0]).toEqual({ command: 'npm test', at: 'workspace' });
      expect(outcome.state.pendingReviewCommands).toEqual(['npm test']);
      expect(outcome).toMatchObject({ kind: 'ran', discharged: ['npm test'] });
    });
  });

  it.each([
    { name: 'missing', chosen: plan([['V1', 'node --version']]) },
    {
      name: 'after another command',
      chosen: plan([
        ['V1', 'node --version'],
        ['V2', 'npm test'],
      ]),
    },
    { name: 'with different text', chosen: plan([['V1', 'npm run test']]) },
  ])('returns a protocol error when the fix command stays $name', async ({ chosen }) => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-fix-protocol' }, async (run) => {
      const { outcome, prompts, checksCall, commands } = await reviewChecks(run, {
        state: { pendingReviewCommands: ['npm test'] },
        plan: chosen,
      });

      expect(outcome.kind).toBe('protocol-error');
      expect(checksCall).toHaveBeenCalledTimes(2);
      expect(prompts[1]).toContain('choose `npm test` among the first 1 commands');
      expect(commands).toEqual([]);
      expect(outcome.state.pendingReviewCommands).toEqual(['npm test']);
    });
  });

  it('accepts either order among the required commands before other commands', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-fix-order' }, async (run) => {
      const { outcome, checksCall, commands, ref } = await reviewChecks(run, {
        state: { pendingReviewCommands: ['npm test', 'npx --no-install vitest run'] },
        plan: plan([
          ['V1', 'npx --no-install vitest run'],
          ['V2', 'npm test'],
          ['V3', 'node --version'],
        ]),
      });

      expect(outcome.kind).toBe('ran');
      expect(checksCall).toHaveBeenCalledTimes(1);
      expect(commands.map((entry) => entry.command)).toEqual([
        'npx --no-install vitest run',
        'npm test',
        'node --version',
      ]);
      expect(outcome.state.pendingReviewCommands).toEqual([
        'npm test',
        'npx --no-install vitest run',
      ]);
      expect(loadState(ref)?.pendingReviewCommands).toEqual(outcome.state.pendingReviewCommands);
      expect(outcome).toMatchObject({
        kind: 'ran',
        discharged: ['npx --no-install vitest run', 'npm test'],
      });
    });
  });

  it.each(['run', 'skip'] as const)(
    'names pending commands beyond the plan limit when the checks %s',
    async (approval) => {
      await withApplyRun(FILES, { sessionId: 'sess-checks-pending-limit' }, async (run) => {
        const pending = Array.from(
          { length: MAX_REVIEW_CHECKS + 1 },
          (_, index) => `npm test -- suite-${index + 1}`,
        );
        const chosen = pending.slice(0, MAX_REVIEW_CHECKS);
        const { outcome, prompts, commands, ref } = await reviewChecks(run, {
          state: { pendingReviewCommands: pending },
          plan: plan(chosen.map((command, index) => [`V${index + 1}`, command])),
          config: makeConfig({ validation: { approveChecks: 'ask' } }),
          onApproval: async () => approval,
        });

        expect(outcome.kind).toBe('ran');
        expect(commands.map((entry) => entry.command)).toEqual(approval === 'run' ? chosen : []);
        expect(outcome.state.pendingReviewCommands).toEqual(pending);
        expect(loadState(ref)?.pendingReviewCommands).toEqual(pending);
        expect(outcome).toMatchObject({
          kind: 'ran',
          discharged: approval === 'run' ? chosen : [],
        });
        expect(prompts[0]).not.toContain(pending[MAX_REVIEW_CHECKS]);
        expect(sectionOf(outcome)).toContain(
          '- `npm test -- suite-7`: not run, a fix check ran it and the plan holds at most 6 commands; it stays pending',
        );
      });
    },
  );

  it('with End-of-run checks off publishes one off row, asks the reviewer nothing and runs nothing', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-off' }, async (run) => {
      const { outcome, events, commands, checksCall } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        config: makeConfig({ validation: { endChecks: false } }),
        state: { pendingReviewCommands: ['npm test'] },
      });

      expect(planned(events)).toEqual([
        expect.objectContaining({ type: 'review_checks', scope: 'final', status: 'off' }),
      ]);
      expect(rows(events)).toEqual([]);
      expect(checksCall).not.toHaveBeenCalled();
      expect(commands).toEqual([]);
      expect(sectionOf(outcome)).toContain('End-of-run checks are off');
      expect(sectionOf(outcome)).toContain('SPLITBRIEF ran no reviewer check before this review');
      expect(outcome.state.reviewChecks).toBeUndefined();
      expect(outcome.state.pendingReviewCommands).toEqual(['npm test']);
      expect(outcome).toMatchObject({ kind: 'ran', discharged: [] });
    });
  });

  it('names the reason of a plan that chooses no command and runs nothing', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-none' }, async (run) => {
      const { outcome, events, commands } = await reviewChecks(run, {
        plan: {
          commands: [],
          declined: [{ target: 'src/a.test.ts', reason: 'the change renames a comment' }],
          reason: 'the change edits only a comment',
        },
      });

      expect(planned(events)).toEqual([
        expect.objectContaining({
          status: 'planned',
          commands: [],
          declined: [{ target: 'src/a.test.ts', reason: 'the change renames a comment' }],
          reason: 'the change edits only a comment',
        }),
      ]);
      expect(commands).toEqual([]);
      expect(sectionOf(outcome)).toContain('You chose no command: the change edits only a comment');
      expect(sectionOf(outcome)).toContain('- src/a.test.ts: the change renames a comment');
    });
  });

  it('stops at the first required command with new failures and leaves the second pending', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-red' }, async (run) => {
      const { outcome, events, commands, ref } = await reviewChecks(run, {
        state: { pendingReviewCommands: ['npm test', 'npx --no-install vitest run'] },
        plan: plan([
          ['V1', 'npm test'],
          ['V2', 'npx --no-install vitest run'],
        ]),
        answer: (command, at) =>
          command === 'npm test' && at === 'workspace' ? { red: NEW_RED } : 'pass',
      });

      expect(commands).toEqual([
        { command: 'npm test', at: 'workspace' },
        { command: 'npm test', at: 'base' },
      ]);
      expect(
        rows(events).map((row) => [row.id, row.moment, row.status, row.passed, row.detail]),
      ).toEqual([
        ['V1', 'pre-review', 'running', undefined, undefined],
        ['V1', 'pre-review', 'done', false, undefined],
        ['V1', 'base', 'running', undefined, undefined],
        ['V1', 'base', 'done', true, undefined],
        ['V2', 'pre-review', 'not-run', undefined, 'V1 failed'],
      ]);
      const state = outcome.state;
      expect(state.pendingReviewCommands).toEqual(['npm test', 'npx --no-install vitest run']);
      expect(loadState(ref)?.pendingReviewCommands).toEqual(state.pendingReviewCommands);
      expect(outcome).toMatchObject({ kind: 'ran', discharged: ['npm test'] });
      expect(state.reviewChecks).toMatchObject({ scope: 'final', plan: { reason: null } });
      expect(state.pendingTriage?.inputs).toEqual([
        expect.objectContaining({
          id: 'V1.1',
          kind: 'defect',
          source: 'check',
          file: 'src/a.ts',
          checkIds: ['V1'],
          command: 'npm test',
          output: NEW_RED,
          failureKeys: [NEW_RED],
          redKeys: [NEW_RED],
        }),
      ]);
      expect(state.pendingTriage?.inputs[0]?.text).toContain('Reviewer check V1 (npm test)');
      const logged = readEvidenceLedger(ref)?.tasks[0]?.checks ?? [];
      expect(logged).toEqual([
        expect.objectContaining({ id: 'V1', command: 'npm test', exitCode: 1 }),
      ]);
      expect(sectionOf(outcome)).toContain(
        '- V2 `npx --no-install vitest run`: not run, V1 failed',
      );
    });
  });

  it('marks a red that also fails at the run base pre-existing and runs the next command', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-old-red' }, async (run) => {
      const { outcome, events, commands, ref } = await reviewChecks(run, {
        plan: plan([
          ['V1', 'npm test'],
          ['V2', 'npx --no-install vitest run'],
        ]),
        answer: (command) => (command === 'npm test' ? { red: OLD_RED } : 'pass'),
      });

      expect(commands.map((entry) => `${entry.command} @ ${entry.at}`)).toEqual([
        'npm test @ workspace',
        'npm test @ base',
        'npx --no-install vitest run @ workspace',
      ]);
      expect(rows(events).filter((row) => row.status === 'done')).toEqual([
        expect.objectContaining({ id: 'V1', moment: 'pre-review', passed: false }),
        expect.objectContaining({
          id: 'V1',
          moment: 'base',
          passed: false,
          newFailures: 0,
          preExisting: 1,
        }),
        expect.objectContaining({ id: 'V2', moment: 'pre-review', passed: true }),
      ]);
      expect(
        rows(events).find((row) => row.moment === 'base' && row.status === 'done'),
      ).not.toHaveProperty('detail');
      expect(outcome.state.pendingTriage).toBeUndefined();
      const logged = readEvidenceLedger(ref)?.tasks[0]?.checks ?? [];
      expect(logged.find((entry) => entry.id === 'V1')).toMatchObject({
        preExisting: [OLD_RED],
      });
      expect(sectionOf(outcome)).toContain(
        `failed, 0 new failure(s); 1 pre-existing (also red at the run base)\ncheck V1 did not pass (fail): 1 failure\nPre-existing failures (also red at the run base):\n- ${OLD_RED}\nOutput tail:`,
      );
    });
  });

  // Q2 review B3: the base row read `fails at the run base too` whether the run stopped or went on.
  it('counts and labels the new and pre-existing keys of a mixed red', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-mixed-red' }, async (run) => {
      const { outcome, events } = await reviewChecks(run, {
        plan: plan([
          ['V1', 'npm test'],
          ['V2', 'npx --no-install vitest run'],
        ]),
        answer: (command, at) =>
          command !== 'npm test'
            ? 'pass'
            : { red: at === 'workspace' ? `${NEW_RED}\n${OLD_RED}` : OLD_RED },
      });

      expect(
        rows(events).map((row) => [
          row.id,
          row.moment,
          row.status,
          row.newFailures,
          row.preExisting,
        ]),
      ).toEqual([
        ['V1', 'pre-review', 'running', undefined, undefined],
        ['V1', 'pre-review', 'done', undefined, undefined],
        ['V1', 'base', 'running', undefined, undefined],
        ['V1', 'base', 'done', 1, 1],
        ['V2', 'pre-review', 'not-run', undefined, undefined],
      ]);
      const listing = sectionOf(outcome).split('Output tail:')[0] ?? '';
      expect(listing).toContain(
        `New failures:\n- ${NEW_RED}\nPre-existing failures (also red at the run base):\n- ${OLD_RED}`,
      );
      expect(outcome.state.pendingTriage?.inputs[0]?.text).toContain(`New failures:\n- ${NEW_RED}`);
      expect(outcome.state.pendingTriage?.inputs[0]?.text).not.toContain(OLD_RED);
    });
  });

  it('refuses a command the policy rejects, names it in the section and never runs it', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-refused' }, async (run) => {
      const { outcome, events, commands } = await reviewChecks(run, {
        state: { pendingReviewCommands: ['npm test && rm -rf src'] },
        plan: plan([['V1', 'npm test && rm -rf src']]),
      });

      expect(commands).toEqual([]);
      expect(outcome.state.pendingReviewCommands).toEqual(['npm test && rm -rf src']);
      expect(outcome).toMatchObject({ kind: 'ran', discharged: [] });
      expect(rows(events).at(-1)).toMatchObject({
        id: 'V1',
        status: 'refused',
        detail: 'contains a shell operator',
      });
      expect(sectionOf(outcome)).toContain(
        '- V1 `npm test && rm -rf src`: refused, contains a shell operator',
      );
    });
  });

  it('returns a protocol error when the reviewer never answers a valid plan', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-protocol' }, async (run) => {
      const { outcome, events, commands } = await reviewChecks(run, { plan: null });

      expect(outcome.kind).toBe('protocol-error');
      expect(planned(events)).toEqual([]);
      expect(commands).toEqual([]);
    });
  });
  it('queues a new failure when the workspace times out and the run base passes', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-timeout-new' }, async (run) => {
      const { outcome, events } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        answer: (command, at) =>
          at === 'workspace'
            ? { throws: processError.timeout({ command, timeoutMs: 1000, output: '' }) }
            : 'pass',
      });

      expect(rows(events).filter((row) => row.status === 'done')).toEqual([
        expect.objectContaining({ id: 'V1', moment: 'pre-review', passed: false }),
        expect.objectContaining({ id: 'V1', moment: 'base', passed: true }),
      ]);
      expect(outcome.state.pendingTriage?.inputs).toEqual([
        expect.objectContaining({ id: 'V1.1', file: null }),
      ]);
      expect(outcome.state.pendingTriage?.inputs[0]?.notVerified).toBeUndefined();
      expect(outcome.state.pendingTriage?.inputs[0]?.text).toContain(
        'failed with new failures. No task changed it.\ncheck V1 did not pass (fail):',
      );
      expect(outcome.state.pendingTriage?.inputs[0]?.text).toContain('timed out');
      expect(sectionOf(outcome)).toContain(
        '- V1 `npm test`: failed, 1 new failure(s)\ncheck V1 did not pass (fail):',
      );
    });
  });

  it('marks a timeout at both the workspace and the run base not verified, never pre-existing', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-timeout-old' }, async (run) => {
      const { outcome, events, commands, ref } = await reviewChecks(run, {
        plan: plan([
          ['V1', 'npm test'],
          ['V2', 'npx --no-install vitest run'],
        ]),
        answer: (command) =>
          command === 'npm test'
            ? { throws: processError.timeout({ command, timeoutMs: 1000, output: '' }) }
            : 'pass',
      });

      expect(commands.map((entry) => `${entry.command} @ ${entry.at}`)).toEqual([
        'npm test @ workspace',
        'npm test @ base',
      ]);
      expect(
        rows(events).find((row) => row.moment === 'base' && row.status === 'done'),
      ).toMatchObject({
        id: 'V1',
        passed: false,
        newFailures: 0,
        preExisting: 0,
        notVerified: 1,
        detail: 'both runs timed out',
      });
      expect(outcome.state.pendingTriage?.inputs).toEqual([
        expect.objectContaining({
          id: 'V1.1',
          file: null,
          checkIds: ['V1'],
          notVerified: 'both runs timed out',
        }),
      ]);
      expect(outcome.state.pendingTriage?.inputs[0]?.text).toContain(
        'failed and failed at the run base too, but SPLITBRIEF could not verify it is the same failure (both runs timed out); the reviewer decides.',
      );
      expect(sectionOf(outcome)).toContain(
        '- V1 `npm test`: failed, not verified at the run base (both runs timed out); the reviewer decides\ncheck V1 did not pass (fail):',
      );
      expect(sectionOf(outcome)).toContain(
        '- V2 `npx --no-install vitest run`: not run, V1 failed',
      );
      expect(sectionOf(outcome)).toContain('A failure marked not verified at the run base');
      const logged = readEvidenceLedger(ref)?.tasks[0]?.checks ?? [];
      expect(logged.find((entry) => entry.id === 'V1')?.preExisting).toBeUndefined();
    });
  });

  it('marks two reds without diagnostics and the same exit code not verified, never pre-existing', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-silent-both' }, async (run) => {
      const { outcome } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        answer: () => ({ red: '' }),
      });

      expect(outcome.state.pendingTriage?.inputs.map((input) => input.id)).toEqual(['V1.1']);
      expect(sectionOf(outcome)).toContain(
        '- V1 `npm test`: failed, not verified at the run base (both runs exited with code 1 without diagnostics); the reviewer decides\ncheck V1 did not pass (fail):',
      );
    });
  });

  it('marks incomplete captures at both runs not verified and never pre-existing', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-incomplete' }, async (run) => {
      const { outcome, events } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        answer: (command) => ({
          throws: processError.exitCode({
            command,
            code: 1,
            output: NEW_RED,
            stderr: '',
            truncated: true,
          }),
        }),
      });
      expect(
        rows(events).find((row) => row.moment === 'base' && row.status === 'done'),
      ).toMatchObject({ preExisting: 0, notVerified: 1 });
      expect(outcome.state.pendingTriage?.inputs[0]?.redKeys).toEqual([
        'output over the capture limit',
      ]);
    });
  });

  it.each([
    {
      name: 'an npm script banner',
      command: 'npm test',
      files: FILES,
      red: '> x@1.0.0 test\n> node -e "process.exit(1)"',
      reason: 'both runs exited with code 1 without diagnostics',
    },
    {
      name: 'a make error summary',
      command: 'make check',
      files: { ...FILES, Makefile: 'check:\n\t@exit 1\n' },
      red: 'make: *** [Makefile:2: check] Error 1',
      reason: 'both runs exited with code 1: make: *** [Makefile:2: check] Error 1',
    },
  ])('marks two reds that print only $name not verified, never pre-existing', async (red) => {
    await withApplyRun(red.files, { sessionId: 'sess-checks-runner-lines' }, async (run) => {
      const { outcome, events, commands, ref } = await reviewChecks(run, {
        plan: plan([['V1', red.command]]),
        answer: () => ({ red: red.red }),
      });

      expect(commands).toEqual([
        { command: red.command, at: 'workspace' },
        { command: red.command, at: 'base' },
      ]);
      expect(
        rows(events).find((row) => row.moment === 'base' && row.status === 'done'),
      ).toMatchObject({
        id: 'V1',
        passed: false,
        newFailures: 0,
        preExisting: 0,
        notVerified: 1,
        detail: red.reason,
      });
      expect(outcome.state.pendingTriage?.inputs).toEqual([
        expect.objectContaining({
          id: 'V1.1',
          file: null,
          checkIds: ['V1'],
          output: red.red,
          notVerified: red.reason,
        }),
      ]);
      expect(outcome.state.pendingTriage?.inputs[0]?.text).toContain(
        `failed and failed at the run base too, but SPLITBRIEF could not verify it is the same failure (${red.reason}); the reviewer decides.`,
      );
      expect(sectionOf(outcome)).toContain(
        `- V1 \`${red.command}\`: failed, not verified at the run base (${red.reason}); the reviewer decides\ncheck V1 did not pass (fail): ${red.red}`,
      );
      const logged = readEvidenceLedger(ref)?.tasks[0]?.checks ?? [];
      expect(logged.find((entry) => entry.id === 'V1')?.preExisting).toBeUndefined();
    });
  });

  it('marks a red with diagnostics not verified when the run base re-run times out', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-base-timeout' }, async (run) => {
      const { outcome, events } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        answer: (command, at) =>
          at === 'workspace'
            ? { red: OLD_RED }
            : { throws: processError.timeout({ command, timeoutMs: 1000, output: '' }) },
      });

      expect(sectionOf(outcome)).toContain(
        'not verified at the run base (the run base re-run timed out); the reviewer decides',
      );
      expect(outcome.state.pendingTriage?.inputs.map((input) => input.id)).toEqual(['V1.1']);
      expect(
        rows(events).find((row) => row.moment === 'base' && row.status === 'done'),
      ).toMatchObject({ newFailures: 0, preExisting: 0, notVerified: 1 });
    });
  });

  // C3 review: a base commit Git could not check out crashed the review and left the base row
  // running.
  it('marks a red not verified with the Git error when the run base cannot be checked out', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-base-checkout' }, async (run) => {
      const unreachable = 'f'.repeat(40);
      const { outcome, events, commands, ref } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        state: {
          workspace: { ...run.workspace, base: { ...run.workspace.base, head: unreachable } },
        },
        answer: (_command, at) => (at === 'workspace' ? { red: NEW_RED } : 'pass'),
      });

      expect(commands).toEqual([{ command: 'npm test', at: 'workspace' }]);
      expect(
        rows(events)
          .filter((row) => row.moment === 'base')
          .map((row) => [row.status, row.passed, row.newFailures, row.notVerified]),
      ).toEqual([
        ['running', undefined, undefined, undefined],
        ['done', false, 0, 1],
      ]);
      const settled = rows(events).find((row) => row.moment === 'base' && row.status === 'done');
      expect(settled?.detail).toContain('the run base could not be prepared');
      expect(settled?.detail).toContain(unreachable);
      expect(sectionOf(outcome)).toContain(
        '- V1 `npm test`: failed, not verified at the run base (the run base could not be prepared',
      );
      expect(sectionOf(outcome)).toContain(`Failures:\n- ${NEW_RED}\nOutput tail:`);
      expect(outcome.state.pendingTriage?.inputs.map((input) => input.id)).toEqual(['V1.1']);
      expect(outcome.state.pendingTriage?.inputs[0]?.text).toContain(
        'SPLITBRIEF could not verify its run base re-run (the run base could not be prepared',
      );
      expect(outcome.state.pendingTriage?.inputs[0]?.text).not.toContain(
        'failed at the run base too',
      );
      const logged = readEvidenceLedger(ref)?.tasks[0]?.checks ?? [];
      expect(logged.find((entry) => entry.id === 'V1')).toBeDefined();
      expect(logged.find((entry) => entry.id === 'V1')).not.toHaveProperty('base');
    });
  });

  it.each(['reconcile', 'link'] as const)(
    'settles a base preparation %s failure as not verified with its error',
    async (step) => {
      await withApplyRun(
        FILES,
        {
          sessionId: `sess-checks-base-${step}`,
          atBase: (dir) => writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n'),
        },
        async (run) => {
          mkdirSync(join(run.dir, 'node_modules'));
          mkdirSync(runBaseTreesRoot(), { recursive: true });
          const before = readdirSync(runBaseTreesRoot());
          const failure = new Error(`${step} preparation denied`);
          if (step === 'reconcile') {
            const rename = fs.rename;
            vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
              if (String(target).startsWith(runBaseTreesRoot())) throw failure;
              return rename(source, target);
            });
          } else {
            vi.spyOn(fs, 'symlink').mockRejectedValueOnce(failure);
          }
          const { outcome, events, commands, ref } = await reviewChecks(run, {
            plan: plan([['V1', 'npm test']]),
            answer: () => ({ red: NEW_RED }),
          });
          expect(commands).toEqual([{ command: 'npm test', at: 'workspace' }]);
          expect(
            rows(events)
              .filter((row) => row.moment === 'base')
              .map((row) => [row.status, row.passed, row.newFailures, row.notVerified]),
          ).toEqual([
            ['running', undefined, undefined, undefined],
            ['done', false, 0, 1],
          ]);
          const settled = rows(events).find(
            (row) => row.moment === 'base' && row.status === 'done',
          );
          expect(settled?.detail).toContain('the run base could not be prepared');
          expect(settled?.detail).toContain(failure.message);
          expect(sectionOf(outcome)).toContain(`not verified at the run base`);
          expect(sectionOf(outcome)).toContain(failure.message);
          expect(outcome.state.pendingTriage?.inputs.map((input) => input.id)).toEqual(['V1.1']);
          expect(outcome.state.pendingTriage?.inputs[0]?.text).toContain(failure.message);
          const logged = readEvidenceLedger(ref)?.tasks[0]?.checks ?? [];
          expect(logged.find((entry) => entry.id === 'V1')).toBeDefined();
          expect(logged.find((entry) => entry.id === 'V1')).not.toHaveProperty('base');
          expect(readdirSync(runBaseTreesRoot())).toEqual(before);
        },
      );
    },
  );

  it('settles a preparation failure with both the original and cleanup errors', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-base-cleanup' }, async (run) => {
      mkdirSync(runBaseTreesRoot(), { recursive: true });
      const before = readdirSync(runBaseTreesRoot());
      const remove = fs.rm;
      vi.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
        if (String(path).startsWith(runBaseTreesRoot())) throw new Error('base cleanup denied');
        return remove(path, options);
      });
      try {
        const { outcome, events, commands } = await reviewChecks(run, {
          plan: plan([['V1', 'npm test']]),
          state: {
            workspace: { ...run.workspace, base: { ...run.workspace.base, head: 'f'.repeat(40) } },
          },
          answer: () => ({ red: NEW_RED }),
        });
        expect(commands).toEqual([{ command: 'npm test', at: 'workspace' }]);
        const settled = rows(events).find((row) => row.moment === 'base' && row.status === 'done');
        expect(settled?.notVerified).toBe(1);
        expect(settled?.detail).toContain('f'.repeat(40));
        expect(settled?.detail).toContain('base cleanup denied');
        expect(sectionOf(outcome)).toContain('base cleanup denied');
        expect(outcome.state.pendingTriage?.inputs[0]?.text).toContain('base cleanup denied');
      } finally {
        vi.restoreAllMocks();
        for (const name of readdirSync(runBaseTreesRoot())) {
          if (!before.includes(name)) rmSync(join(runBaseTreesRoot(), name), { recursive: true });
        }
      }
    });
  });

  it.each(['pass', 'fail'] as const)(
    'settles a completed %s base command with its cleanup error and continues the review',
    async (baseStatus) => {
      await withApplyRun(FILES, { sessionId: 'sess-checks-completed-cleanup' }, async (run) => {
        mkdirSync(runBaseTreesRoot(), { recursive: true });
        const before = readdirSync(runBaseTreesRoot());
        let tree = '';
        try {
          const { outcome, events, commands, ref } = await reviewChecks(run, {
            plan: plan([
              ['V1', 'npm test'],
              ['V2', 'npx --no-install vitest run'],
            ]),
            answer: (command, at) => {
              if (command !== 'npm test') return 'pass';
              if (at === 'workspace') return { red: OLD_RED };
              const name = readdirSync(runBaseTreesRoot()).find((entry) => !before.includes(entry));
              if (name === undefined) throw new Error('the base command has no tree');
              tree = join(runBaseTreesRoot(), name);
              execFileSync('git', ['worktree', 'lock', tree], { cwd: run.dir, stdio: 'pipe' });
              return baseStatus === 'pass' ? 'pass' : { red: OLD_RED };
            },
          });
          expect(outcome.kind).toBe('ran');
          expect(
            rows(events)
              .filter((row) => row.moment === 'base')
              .map((row) => row.status),
          ).toEqual(['running', 'done']);
          const settled = rows(events).find(
            (row) => row.moment === 'base' && row.status === 'done',
          );
          expect(settled).toMatchObject({
            passed: false,
            newFailures: 0,
            preExisting: 0,
            notVerified: 1,
          });
          expect(settled?.detail).toContain('cleanup of run base tree');
          expect(settled?.detail).toContain(tree);
          expect(settled?.detail).toContain('locked');
          expect(commands).toEqual([
            { command: 'npm test', at: 'workspace' },
            { command: 'npm test', at: 'base' },
          ]);
          const logged = (readEvidenceLedger(ref)?.tasks[0]?.checks ?? []).find(
            (entry) => entry.id === 'V1',
          );
          expect(logged).toBeDefined();
          expect(logged).not.toHaveProperty('base');
          expect(logged?.preExisting).toBeUndefined();
          expect(outcome.state.pendingTriage?.inputs.map((input) => input.id)).toEqual(['V1.1']);
          expect(outcome.state.pendingTriage?.inputs[0]?.text).toContain('locked');
          expect(outcome.state.pendingTriage?.inputs[0]?.text).not.toContain(
            'failed at the run base too',
          );
          expect(sectionOf(outcome)).toContain('not verified at the run base');
          expect(sectionOf(outcome)).toContain('locked');
          expect(rows(events).find((row) => row.id === 'V2')).toMatchObject({ status: 'not-run' });
          expect(existsSync(tree)).toBe(true);
          expect(existsSync(join(run.dir, '.git/worktrees', basename(tree)))).toBe(true);
        } finally {
          if (tree !== '') {
            execFileSync('git', ['worktree', 'unlock', tree], { cwd: run.dir, stdio: 'pipe' });
            execFileSync('git', ['worktree', 'remove', '--force', tree], {
              cwd: run.dir,
              stdio: 'pipe',
            });
          }
        }
      });
    },
  );

  it('warns about a stale tree it cannot remove while repeated base re-runs still compare keys', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-stale-cleanup' }, async (run) => {
      mkdirSync(runBaseTreesRoot(), { recursive: true });
      const gone = spawnSync(process.execPath, ['-e', '']).pid;
      const stale = join(runBaseTreesRoot(), `base-${gone}-locked`);
      execFileSync('git', ['worktree', 'add', '--detach', stale, 'HEAD'], {
        cwd: run.dir,
        stdio: 'pipe',
      });
      execFileSync('git', ['worktree', 'lock', stale], { cwd: run.dir, stdio: 'pipe' });
      const warnings: string[] = [];
      const restore = installDiagnosticSink((message) => warnings.push(message));
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const { outcome, events, commands } = await reviewChecks(run, {
            plan: plan([
              ['V1', 'npm test'],
              ['V2', 'npx --no-install vitest run'],
            ]),
            answer: (command) => (command === 'npm test' ? { red: OLD_RED } : 'pass'),
          });
          expect(outcome.kind).toBe('ran');
          expect(commands).toEqual([
            { command: 'npm test', at: 'workspace' },
            { command: 'npm test', at: 'base' },
            { command: 'npx --no-install vitest run', at: 'workspace' },
          ]);
          const settled = rows(events).find(
            (row) => row.moment === 'base' && row.status === 'done',
          );
          expect(settled).toMatchObject({ passed: false, newFailures: 0, preExisting: 1 });
          expect(settled).not.toHaveProperty('detail');
          expect(sectionOf(outcome)).toContain(
            'failed, 0 new failure(s); 1 pre-existing (also red at the run base)\n',
          );
          expect(sectionOf(outcome)).toContain(
            'Pre-existing failures (also red at the run base):\n- src/legacy.ts(3,7)',
          );
          expect(existsSync(stale)).toBe(true);
          expect(existsSync(join(run.dir, '.git/worktrees', basename(stale)))).toBe(true);
        }
        expect(warnings).toHaveLength(2);
        expect(warnings.every((warning) => warning.includes(stale))).toBe(true);
        expect(warnings.every((warning) => warning.includes('locked'))).toBe(true);
      } finally {
        restore();
        execFileSync('git', ['worktree', 'unlock', stale], { cwd: run.dir, stdio: 'pipe' });
        execFileSync('git', ['worktree', 'remove', '--force', stale], {
          cwd: run.dir,
          stdio: 'pipe',
        });
      }
    });
  });

  // L4: the base re-run of a live run was red for reasons nobody could read; its output was dropped.
  it('records the base re-run output on the check evidence beside the workspace output', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-base-output' }, async (run) => {
      const { ref } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        answer: (_command, at) => ({ red: at === 'workspace' ? NEW_RED : OLD_RED }),
      });

      const logged = readEvidenceLedger(ref)?.tasks[0]?.checks ?? [];
      expect(logged.find((entry) => entry.id === 'V1')).toMatchObject({
        exitCode: 1,
        output: NEW_RED,
        base: { exitCode: 1, output: OLD_RED },
      });
    });
  });

  // L4 review B1: a long red kept only its first 4000 characters and its last 4096, so a vitest
  // failure list at the end was lost and both sides matched on the same stderr notice.
  it('keys a long red by its whole output, so a stderr notice it shares with the run base is its only pre-existing key', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-long-red' }, async (run) => {
      const passing = Array.from({ length: 200 }, (_, i) => ` ✓ src/x.test.ts > passes ${i} 2ms`);
      const red = (failing: string) => ({
        red: [...passing, ` FAIL  ${failing}`].join('\n'),
        stderr: 'biome.json:38: the key files.ignore is deprecated',
      });
      const { outcome, events, ref } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        answer: (_command, at) =>
          red(at === 'workspace' ? 'src/new.test.ts > adds' : 'src/old.test.ts > keeps'),
      });

      expect(
        rows(events).find((row) => row.moment === 'base' && row.status === 'done'),
      ).toMatchObject({ newFailures: 1, preExisting: 1 });
      expect(outcome.state.pendingTriage?.inputs[0]?.text).toContain('src/new.test.ts::adds');
      const logged = readEvidenceLedger(ref)?.tasks[0]?.checks ?? [];
      expect(logged.find((entry) => entry.id === 'V1')?.preExisting).toEqual([
        'biome.json:38: the key files.ignore is deprecated',
      ]);
    });
  });

  it('marks a red at a run base copy with no base commit not verified, even when its keys match', async () => {
    await withApplyRun(
      FILES,
      { sessionId: 'sess-checks-base-incomplete', strategy: 'staged-copy' },
      async (run) => {
        const { outcome, events, ref } = await reviewChecks(run, {
          plan: plan([['V1', 'npm test']]),
          answer: () => ({ red: OLD_RED }),
        });

        const reason =
          'the run recorded no base commit, so its run base copy has no Git history, file modes or symlinks';
        expect(sectionOf(outcome)).toContain(
          `- V1 \`npm test\`: failed, not verified at the run base (${reason}); the reviewer decides\ncheck V1 did not pass (fail): 1 failure\nFailures:\n- ${OLD_RED}\nOutput tail:`,
        );
        expect(outcome.state.pendingTriage?.inputs.map((input) => input.id)).toEqual(['V1.1']);
        expect(
          rows(events).find((row) => row.moment === 'base' && row.status === 'done'),
        ).toMatchObject({ newFailures: 0, preExisting: 0, notVerified: 1, detail: reason });
        const logged = readEvidenceLedger(ref)?.tasks[0]?.checks ?? [];
        expect(logged.find((entry) => entry.id === 'V1')?.preExisting).toBeUndefined();
      },
    );
  });

  it('runs a reviewer check of any stack, and a package script without plan approval', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-any-stack' }, async (run) => {
      const { outcome, commands } = await reviewChecks(run, {
        plan: plan([
          ['V1', 'mvn test'],
          ['V2', 'npm run lint'],
          ['V3', './gradlew test'],
          ['V4', 'bin/test'],
        ]),
        state: { approve: 'none' },
      });

      expect(commands).toEqual([
        { command: 'mvn test', at: 'workspace' },
        { command: 'npm run lint', at: 'workspace' },
        { command: './gradlew test', at: 'workspace' },
      ]);
      expect(sectionOf(outcome)).toContain('- V4 `bin/test`: refused, runs a program by path');
    });
  });

  it('names the exit code of a red command that printed nothing, with no file', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-silent' }, async (run) => {
      const { outcome } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        answer: (_command, at) => (at === 'workspace' ? { red: '' } : 'pass'),
      });

      expect(outcome.state.pendingTriage?.inputs).toEqual([
        expect.objectContaining({ id: 'V1.1', file: null }),
      ]);
      expect(outcome.state.pendingTriage?.inputs[0]?.text).toContain('exited with code 1');
      expect(outcome.state.pendingTriage?.inputs[0]?.text).toContain('No task changed it.');
    });
  });

  it('queues one input per failing file, each naming the task that last changed it', async () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done', suggestedFiles: ['src/a.ts'] }),
      makeTask({ id: 'T002', status: 'done', suggestedFiles: ['src/b.ts'] }),
    ];
    await withApplyRun(
      { ...FILES, 'src/b.ts': 'export const b = 2;\n' },
      { sessionId: 'sess-checks-owners' },
      async (run) => {
        let ledger = createEvidenceLedger({ sessionId: run.sessionId, feature: 'f', tasks });
        for (const [task, file] of [
          [tasks[0], 'src/a.ts'],
          [tasks[1], 'src/b.ts'],
        ] as const) {
          if (task === undefined) throw new Error('missing task fixture');
          ledger = recordLocalTaskEvidence({
            ledger,
            task,
            status: 'done',
            changedFiles: [file],
          });
        }
        writeEvidenceLedger({ projectDir: run.dir, sessionId: run.sessionId }, ledger);

        const { outcome } = await reviewChecks(run, {
          plan: plan([['V1', 'npm test']]),
          tasks,
          answer: (_command, at) =>
            at === 'workspace'
              ? { red: `${NEW_RED}\nsrc/b.ts(2,3): error TS2304: Cannot find name x.` }
              : 'pass',
        });

        const inputs = outcome.state.pendingTriage?.inputs ?? [];
        expect(inputs.map((input) => [input.id, input.file])).toEqual([
          ['V1.1', 'src/a.ts'],
          ['V1.2', 'src/b.ts'],
        ]);
        expect(inputs[0]?.text).toContain('Last changed by T001.');
        expect(inputs[1]?.text).toContain('Last changed by T002.');
        expect(inputs[0]?.text).toContain(`- ${NEW_RED}`);
        expect(inputs[0]?.text).not.toContain('src/b.ts');
        expect(inputs[1]?.text).toContain('- src/b.ts(2,3): error TS2304: Cannot find name x.');
        expect(inputs[1]?.text).not.toContain('src/a.ts');
      },
    );
  });

  // Live run 2026-10-09: a fix task must know which failures of the red command are its own.
  it('queues an input only for a file with new failures, carrying the new keys that name it', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-own-keys' }, async (run) => {
      const { outcome } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        answer: (_command, at) => ({
          red: at === 'workspace' ? `${NEW_RED}\n${OLD_RED}` : OLD_RED,
        }),
      });

      expect(
        (outcome.state.pendingTriage?.inputs ?? []).map((input) => [
          input.id,
          input.file,
          input.failureKeys,
        ]),
      ).toEqual([['V1.1', 'src/a.ts', [NEW_RED]]]);
      expect(outcome.state.pendingTriage?.inputs[0]?.redKeys).toEqual([NEW_RED, OLD_RED]);
    });
  });

  it('names a new failure that only the head of a long output shows', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-long-red' }, async (run) => {
      const noise = Array.from(
        { length: 200 },
        (_, index) => `    Type 'Section<${index}>' is not assignable to type 'Section<never>'.`,
      ).join('\n');
      const { outcome } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        answer: (_command, at) =>
          at === 'workspace' ? { red: `${NEW_RED}\n${noise}\n${OLD_RED}` } : { red: OLD_RED },
      });

      expect(
        (outcome.state.pendingTriage?.inputs ?? []).map((input) => [input.file, input.failureKeys]),
      ).toEqual([['src/a.ts', [NEW_RED]]]);
    });
  });

  it('bounds each file listing and keeps test assertions when the output tail is noise', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-test-messages' }, async (run) => {
      const noise = 'runner event\n'.repeat(500);
      const { outcome } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        answer: (_command, at) =>
          at === 'base'
            ? 'pass'
            : {
                red: [
                  ...Array.from(
                    { length: 12 },
                    (_line, index) =>
                      ` FAIL  src/a.test.ts > adds ${index}\nAssertionError: expected ${index} to be 20`,
                  ),
                  ' FAIL  src/b.test.ts > subtracts',
                  'AssertionError: expected 3 to be 4',
                  noise,
                ].join('\n'),
              },
      });
      const inputs = outcome.state.pendingTriage?.inputs ?? [];

      expect(inputs.map((input) => input.file)).toEqual(['src/a.test.ts', 'src/b.test.ts']);
      expect(inputs[0]?.output).not.toContain('AssertionError');
      expect(inputs[0]?.text).toContain(
        '12 failures\nFailures:\n- src/a.test.ts::adds 0\n  AssertionError: expected 0 to be 20',
      );
      expect(inputs[0]?.text.match(/^- /gm)).toHaveLength(10);
      expect(inputs[0]?.text).toContain('and 2 more');
      expect(inputs[0]?.text).not.toContain('Output tail:');
      expect(inputs[0]?.text).not.toContain('src/b.test.ts');
      expect(inputs[0]?.text).not.toContain('expected 3 to be 4');
      expect(inputs[1]?.text).toContain(
        '1 failure\nFailures:\n- src/b.test.ts::subtracts\n  AssertionError: expected 3 to be 4',
      );
      expect(inputs[1]?.text).not.toContain('src/a.test.ts');
      expect(inputs[1]?.text).not.toContain('expected 0 to be 20');
      expect(sectionOf(outcome).match(/^- src\/[ab].test.ts::/gm)).toHaveLength(10);
    });
  });

  it('carries no failure keys on an input whose red names no failure', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-no-keys' }, async (run) => {
      const { outcome } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        answer: (_command, at) => (at === 'workspace' ? { red: '' } : 'pass'),
      });

      expect(outcome.state.pendingTriage?.inputs).toEqual([
        expect.objectContaining({ id: 'V1.1', file: null }),
      ]);
      expect(outcome.state.pendingTriage?.inputs[0]).not.toHaveProperty('failureKeys');
    });
  });

  it('queues the failure when the base re-run cannot start, and says why', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-base-missing' }, async (run) => {
      const { outcome, events } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        answer: (command, at) =>
          at === 'workspace' ? { red: NEW_RED } : { throws: processError.notFound(command) },
      });

      expect(
        rows(events)
          .filter((row) => row.moment === 'base')
          .map((row) => [row.id, row.moment, row.status]),
      ).toEqual([
        ['V1', 'base', 'running'],
        ['V1', 'base', 'not-run'],
      ]);
      expect(sectionOf(outcome)).toContain('; base re-run not run: npm not found');
      expect(outcome.state.pendingTriage?.inputs.map((input) => input.id)).toEqual(['V1.1']);
    });
  });

  it('runs no base command when the run recorded no run base, and says so', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-no-base' }, async (run) => {
      const { outcome, events, commands } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        runBase: false,
        answer: () => ({ red: NEW_RED }),
      });

      expect(commands).toEqual([{ command: 'npm test', at: 'workspace' }]);
      expect(rows(events).filter((row) => row.moment === 'base')).toEqual([
        expect.objectContaining({
          id: 'V1',
          status: 'not-run',
          detail: 'this run recorded no run base',
        }),
      ]);
      expect(sectionOf(outcome)).toContain('base re-run not run: this run recorded no run base');
      expect(outcome.state.pendingTriage?.inputs.map((input) => input.id)).toEqual(['V1.1']);
    });
  });

  it('runs the next command after a refused one', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-refused-next' }, async (run) => {
      const { outcome, commands } = await reviewChecks(run, {
        plan: plan([
          ['V1', 'curl https://example.test'],
          ['V2', 'npm test'],
        ]),
      });

      expect(commands).toEqual([{ command: 'npm test', at: 'workspace' }]);
      expect(sectionOf(outcome)).toMatch(/- V1 `curl https:\/\/example\.test`: refused, /);
      expect(sectionOf(outcome)).toContain('- V2 `npm test`: passed');
    });
  });

  it('drops the inputs of an earlier reviewer-check run once the commands pass, and keeps the rest', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-repeat' }, async (run) => {
      const userInput = {
        id: 'P1',
        kind: 'defect' as const,
        source: 'user' as const,
        text: 'The total is wrong.',
        file: 'src/a.ts',
      };
      const question = { question: 'Keep the old API?', whyOnlyUserCanAnswer: 'It is a choice.' };
      const { outcome } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        state: {
          pendingTriage: {
            inputs: [
              userInput,
              {
                id: 'V1.1',
                kind: 'defect',
                source: 'check',
                text: 'Reviewer check V1 (npm test) failed with new failures: x.',
                file: null,
              },
            ],
            question,
          },
        },
      });

      expect(outcome.state.pendingTriage?.inputs).toEqual([userInput]);
      expect(outcome.state.pendingTriage?.question).toEqual(question);
    });
  });

  it('refuses npm test when the run changed the test script, and never runs it', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-checks-changed-script' }, async (run) => {
      writeFileSync(
        join(run.ws, 'package.json'),
        JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
      );
      const { outcome, events, commands } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        state: { pendingReviewCommands: ['npm test'] },
      });

      expect(commands).toEqual([]);
      expect(outcome.state.pendingReviewCommands).toEqual(['npm test']);
      expect(outcome).toMatchObject({ kind: 'ran', discharged: [] });
      expect(rows(events).at(-1)).toMatchObject({
        id: 'V1',
        moment: 'pre-review',
        status: 'refused',
        detail: 'runs the package script test, which this run changed',
      });
      expect(sectionOf(outcome)).toContain(
        '- V1 `npm test`: refused, runs the package script test, which this run changed',
      );
    });
  });

  it('hands an api reviewer the project files verbatim, and a cli reviewer the workspace', async () => {
    const files = {
      ...FILES,
      Justfile: 'test:\n\tcargo test\n',
      '.justfile': 'lint:\n\tcargo clippy\n',
    };
    await withApplyRun(files, { sessionId: 'sess-checks-api' }, async (run) => {
      const api = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        config: makeConfig({
          reviewer: {
            kind: 'api',
            provider: 'ollama',
            model: 'qwen2.5-coder:7b',
            apiBase: 'http://localhost:11434/v1',
          },
        }),
      });
      const prompt = api.prompts[0] ?? '';
      expect(prompt).toContain('### package.json\n');
      expect(prompt).toContain('"test":"vitest run"');
      expect(prompt).toContain('- src/a.ts');
      expect(prompt).toContain('### Justfile\n');
      expect(prompt).toContain('cargo test');
      expect(prompt).toContain('### .justfile\n');
      expect(prompt).toContain('cargo clippy');
      expect(prompt).not.toContain('(trimmed)');

      const cli = await reviewChecks(run, { plan: plan([['V1', 'npm test']]) });
      expect(cli.prompts[0]).not.toContain('### package.json');
      expect(cli.prompts[0]).toContain(run.ws);
    });
  });

  it('trims a project file at 8k characters and stops adding files at 40k', async () => {
    const big = (fill: string) => fill.repeat(9_000);
    const files = {
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, description: big('p') }),
      'src/a.ts': 'export const a = 1;\n',
      Makefile: big('m'),
      justfile: big('j'),
      'pyproject.toml': big('y'),
      'Cargo.toml': big('c'),
      'go.mod': 'module example.test/late\n',
    };
    await withApplyRun(files, { sessionId: 'sess-checks-trim' }, async (run) => {
      const { prompts } = await reviewChecks(run, {
        plan: plan([['V1', 'npm test']]),
        config: makeConfig({
          reviewer: {
            kind: 'api',
            provider: 'ollama',
            model: 'qwen2.5-coder:7b',
            apiBase: 'http://localhost:11434/v1',
          },
        }),
      });
      const prompt = prompts[0] ?? '';

      for (const file of ['package.json', 'Makefile', 'justfile', 'pyproject.toml', 'Cargo.toml']) {
        expect(prompt).toContain(`### ${file} (trimmed)\n`);
      }
      expect(prompt).not.toContain('m'.repeat(8_001));
      expect(prompt).toContain('m'.repeat(8_000));
      expect(prompt).not.toContain('### go.mod');
      expect(prompt).not.toContain('example.test/late');
    });
  });
});

describe('runReviewChecks with validation.approve_checks', { timeout: 60_000 }, () => {
  const ASK = makeConfig({ validation: { approveChecks: 'ask' } });
  const CHOSEN = plan([
    ['V1', 'npm test'],
    ['V2', 'npx --no-install vitest run'],
  ]);

  it('runs every chosen command without asking under auto', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-approve-auto' }, async (run) => {
      const onApproval = vi.fn(async () => 'skip' as const);
      const { outcome, commands } = await reviewChecks(run, { plan: CHOSEN, onApproval });

      expect(onApproval).not.toHaveBeenCalled();
      expect(commands.map((entry) => entry.command)).toEqual([
        'npm test',
        'npx --no-install vitest run',
      ]);
      expect(outcome.state.reviewChecks?.skipped).toBeUndefined();
    });
  });

  it('shows the chosen commands once and runs them on Run all', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-approve-run' }, async (run) => {
      const onApproval = vi.fn(async () => 'run' as const);
      const { outcome, commands } = await reviewChecks(run, {
        plan: CHOSEN,
        config: ASK,
        onApproval,
      });

      expect(onApproval).toHaveBeenCalledOnce();
      expect(onApproval).toHaveBeenCalledWith({ scope: 'final', commands: CHOSEN.commands });
      expect(commands).toHaveLength(2);
      expect(outcome.state.reviewChecks?.skipped).toBeUndefined();
      expect(sectionOf(outcome)).not.toContain('SPLITBRIEF ran none');
    });
  });

  it('runs none of the commands on Skip all, records the skip and tells the verdict call', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-approve-skip' }, async (run) => {
      const { outcome, events, commands, ref } = await reviewChecks(run, {
        plan: CHOSEN,
        config: ASK,
        onApproval: async () => 'skip',
        state: {
          pendingReviewCommands: ['npm test', 'npx --no-install vitest run'],
          pendingTriage: {
            inputs: [
              {
                id: 'V1.1',
                kind: 'defect',
                source: 'check',
                file: null,
                text: 'an earlier red',
                checkIds: ['V1'],
              },
            ],
          },
        },
      });

      expect(commands).toEqual([]);
      expect(rows(events)).toEqual([]);
      expect(outcome.state.pendingReviewCommands).toEqual([
        'npm test',
        'npx --no-install vitest run',
      ]);
      expect(loadState(ref)?.pendingReviewCommands).toEqual(outcome.state.pendingReviewCommands);
      expect(outcome).toMatchObject({ kind: 'ran', discharged: [] });
      expect(planned(events).map((event) => [event.status, event.reason])).toEqual([
        ['planned', null],
        ['skipped', REVIEW_CHECKS_SKIP_REASON.user],
      ]);
      expect(planned(events)[1]?.commands?.map((command) => command.id)).toEqual(['V1', 'V2']);
      expect(outcome.state.reviewChecks?.skipped).toEqual({
        reason: REVIEW_CHECKS_SKIP_REASON.user,
      });
      expect(loadState(ref)?.reviewChecks?.skipped).toEqual({
        reason: REVIEW_CHECKS_SKIP_REASON.user,
      });
      // The earlier run's inputs named commands this review chose again and did not run.
      expect(outcome.state.pendingTriage?.inputs ?? []).toEqual([]);
      const section = sectionOf(outcome);
      expect(section).toContain(
        `SPLITBRIEF ran none of the commands you chose before this review because ${REVIEW_CHECKS_SKIP_REASON.user}. No command below is a pass.`,
      );
      expect(section).toContain('unverified');
      expect(section).toContain(
        `- V2 \`npx --no-install vitest run\`: not run, ${REVIEW_CHECKS_SKIP_REASON.user}`,
      );
    });
  });

  it('runs none of the commands in a run with no screen to ask on, and says why', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-approve-headless' }, async (run) => {
      const { outcome, events, commands } = await reviewChecks(run, { plan: CHOSEN, config: ASK });

      expect(commands).toEqual([]);
      expect(planned(events).at(-1)).toMatchObject({
        status: 'skipped',
        reason: 'validation.approve_checks is ask and this run has no screen to ask on',
      });
      expect(outcome.state.reviewChecks?.skipped?.reason).toBe(REVIEW_CHECKS_SKIP_REASON.noScreen);
      expect(sectionOf(outcome)).toContain(REVIEW_CHECKS_SKIP_REASON.noScreen);
    });
  });

  it('never reads a card closed without an answer as Run all', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-approve-closed' }, async (run) => {
      const { outcome, commands } = await reviewChecks(run, {
        plan: CHOSEN,
        config: ASK,
        onApproval: async () => undefined,
      });

      expect(commands).toEqual([]);
      expect(outcome.state.reviewChecks?.skipped?.reason).toBe(REVIEW_CHECKS_SKIP_REASON.noAnswer);
    });
  });

  it('stops the review when the run is stopped while the card waits', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-approve-abort' }, async (run) => {
      const controller = new AbortController();
      await expect(
        reviewChecks(run, {
          plan: CHOSEN,
          config: ASK,
          signal: controller.signal,
          onApproval: async () => {
            controller.abort();
            return undefined;
          },
        }),
      ).rejects.toThrow();
    });
  });

  it('shows no card for a plan that chose no command', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-approve-none' }, async (run) => {
      const onApproval = vi.fn(async () => 'skip' as const);
      const { outcome, events } = await reviewChecks(run, {
        plan: { commands: [], declined: [], reason: 'the change edits only a comment' },
        config: ASK,
        onApproval,
      });

      expect(onApproval).not.toHaveBeenCalled();
      expect(planned(events).map((event) => event.status)).toEqual(['planned']);
      expect(outcome.state.reviewChecks?.skipped).toBeUndefined();
    });
  });
});
