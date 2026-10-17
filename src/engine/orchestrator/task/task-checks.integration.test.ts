import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Check } from '../../../core/schemas/task.js';
import type { EvidenceCheckEntry } from '../../../core/schemas/evidence.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { withApplyRun, type ApplyRun } from '#testing/helpers/apply-run.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { validateAndCommit } from '../escalation/validate-and-commit.js';
import type { EscalationContext } from '../escalation/types.js';
import type { ValidationCommandRunner, Validator } from '../validation/types.js';
import { makeConfig, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeCommandRunner } from '#testing/helpers/validation-fixtures.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { processError } from '../../../lib/process/errors.js';
import type { EngineEventOf } from '../../events/types.js';
import { runTaskChecks } from './task-checks.js';

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function setup(prefix: string): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix,
    sessionId: `sess-${prefix}`,
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

function recordedChecks(projectDir: string, sessionId: string): EvidenceCheckEntry[] {
  return readEvidenceLedger({ projectDir, sessionId })?.tasks[0]?.checks ?? [];
}

function versionCheck(): Check[] {
  return [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }];
}

function acceptingValidator(): Validator {
  return {
    formatChangedFiles: vi.fn().mockResolvedValue(undefined),
  };
}

async function makeEscalationCtx(opts: {
  projectDir: string;
  sessionId: string;
  validator: Validator;
}): Promise<EscalationContext> {
  const { bus } = makeBusRecorder();
  return {
    ...makeWctx({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      bus,
      validator: opts.validator,
      config: makeNoValidationConfig({ workflow: { review: 'task' } }),
    }),
    taskStartSnapshot: await getChangedFilesSnapshot(opts.projectDir),
    dependsOnFiles: [],
  };
}

describe('runTaskChecks', () => {
  it('runs and records a task checks once on the accepted first attempt', async () => {
    const { projectDir, sessionId } = setup('task-checks-first');
    const task = makeTask({ id: 'T001', checks: versionCheck() });
    const state = makeImplState([task]);
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx({ projectDir, sessionId, bus });

    const result = await runTaskChecks({
      wctx,
      state,
      task,
      checkIds: (task.checks ?? []).map((check) => check.id),
    });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.status).toBe('pass');
    expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'K1', status: 'pass' }]);
    expect(events.filter((event) => event.type === 'checks_run')).toHaveLength(1);
    expect(recordedChecks(projectDir, sessionId).map((entry) => entry.id)).toEqual(['K1']);
  });

  it('records refused and not-run plan checks and shows each row as the pre-review row reads', async () => {
    const { projectDir, sessionId } = setup('task-checks-refused');
    const task = makeTask({
      id: 'T001',
      checks: [
        ...versionCheck(),
        { id: 'K2', kind: 'cmd', value: 'npm run lint', required: true },
        { id: 'K3', kind: 'render', value: 'home', required: false },
      ],
    });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskChecks({
      wctx: makeWctx({ projectDir, sessionId, bus }),
      state: makeImplState([task]),
      task,
      checkIds: ['K1', 'K2', 'K3'],
    });

    expect(result.state.tasks[0]?.checkResults).toEqual([
      { id: 'K1', status: 'pass' },
      { id: 'K2', status: 'refused' },
      { id: 'K3', status: 'not-runnable' },
    ]);
    expect(events.find((event) => event.type === 'checks_run')).toMatchObject({
      results: [
        { id: 'K1', status: 'pass' },
        { id: 'K2', status: 'refused' },
        { id: 'K3', status: 'not-runnable' },
      ],
    });
    expect(
      events
        .filter((event): event is EngineEventOf<'full_suite'> => event.type === 'full_suite')
        .map((row) => [row.id, row.moment, row.status, row.command, row.scenario, row.detail]),
    ).toEqual([
      [
        'K2',
        'plan',
        'refused',
        'npm run lint',
        undefined,
        'runs a package script or binary (npm run)',
      ],
      ['K3', 'plan', 'not-run', '', 'home', 'validation.render is not set'],
    ]);
    expect(
      recordedChecks(projectDir, sessionId).map((entry) => [entry.id, entry.status, entry.output]),
    ).toEqual([
      ['K1', 'pass', expect.any(String)],
      ['K2', 'refused', 'runs a package script or binary (npm run)'],
      ['K3', 'not-runnable', 'validation.render is not set'],
    ]);
  });

  it('announces each plan check as it starts, before the checks it ran are recorded', async () => {
    const { projectDir, sessionId } = setup('task-checks-start');
    const task = makeTask({
      id: 'T001',
      checks: [...versionCheck(), { id: 'K3', kind: 'render', value: 'home', required: false }],
    });
    const { bus, events } = makeBusRecorder();

    await runTaskChecks({
      wctx: makeWctx({ projectDir, sessionId, bus }),
      state: { ...makeImplState([task]), phase: 'validating-task' },
      task,
      checkIds: ['K1', 'K3', 'K404'],
    });

    const started = events.filter(
      (event): event is EngineEventOf<'task_validating'> => event.type === 'task_validating',
    );
    expect(started.map((event) => [event.phase, event.taskId, event.check])).toEqual([
      ['validating-task', 'T001', { id: 'K1', command: 'node --version' }],
      ['validating-task', 'T001', { id: 'K3', command: '', scenario: 'home' }],
    ]);
    const types = events.map((event) => event.type);
    expect(types.lastIndexOf('task_validating')).toBeLessThan(types.indexOf('checks_run'));
    expect(events.find((event) => event.type === 'checks_run')).toMatchObject({
      results: [
        { id: 'K1', status: 'pass' },
        { id: 'K3', status: 'not-runnable' },
        { id: 'K404', status: 'unknown' },
      ],
    });
  });

  it('leaves a task without checks unchanged', async () => {
    const { projectDir, sessionId } = setup('task-checks-none');
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx({ projectDir, sessionId, bus });

    const result = await runTaskChecks({
      wctx,
      state,
      task,
      checkIds: (task.checks ?? []).map((check) => check.id),
    });

    expect(result.runs).toEqual([]);
    expect(result.state).toBe(state);
    expect(events).toHaveLength(0);
  });

  it('runs and records the checks once when a local retry is accepted', async () => {
    const { projectDir, sessionId } = setup('task-checks-retry');
    const task = makeTask({ id: 'T002', checks: versionCheck() });
    const ctx = await makeEscalationCtx({
      projectDir,
      sessionId,
      validator: acceptingValidator(),
    });

    const result = await validateAndCommit({
      ctx,
      attemptSnapshot: ctx.taskStartSnapshot,
      task,
      state: makeImplState([task]),
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      retryCount: 1,
      preApprovedChangedFiles: [task.suggestedFiles[0]],
    });

    expect(result.completed).toBe(true);
    expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'K1', status: 'pass' }]);
    const retryChecks = recordedChecks(projectDir, sessionId).filter((entry) => entry.id === 'K1');
    expect(retryChecks).toHaveLength(1);
  });

  it('never settles a red fix check that names no failure, and runs nothing at the run base', {
    timeout: 60_000,
  }, async () => {
    await withApplyRun(
      { 'src/a.ts': 'export const a = 1;\n' },
      { sessionId: 'sess-task-checks-not-verified' },
      async (run) => {
        const task = makeTask({
          id: 'T001',
          fix: {
            cycle: 1,
            findings: [
              {
                id: 'V1.1',
                text: 'Reviewer check V1 (npm test) failed.',
                acceptance: null,
                checkIds: ['V1'],
                commands: { V1: 'npm test' },
              },
            ],
          },
        });
        const state = makeImplState([task], { workspace: run.workspace });
        const red = (output: string) => () =>
          processError.exitCode({ command: 'npm test', code: 1, stderr: '', output });
        const silent = red('');
        const npmBanner = red('> x@1.0.0 test\n> node -e "process.exit(1)"');
        const makeSummary = red('make: *** [Makefile:2: check] Error 1');
        const timedOut = () =>
          processError.timeout({ command: 'npm test', timeoutMs: 1000, output: '' });
        const wctx = makeWctx({
          projectDir: run.dir,
          sessionId: run.sessionId,
          workspaceDir: run.ws,
          config: makeConfig(),
        });

        for (const fails of [silent, npmBanner, makeSummary, timedOut]) {
          const runner = makeCommandRunner(fails(), fails());
          const result = await runTaskChecks({
            wctx,
            state,
            task,
            checkIds: ['V1'],
            runCommand: runner,
          });

          expect(runner.calls.map((call) => call.options?.cwd === run.ws)).toEqual([true]);
          expect(result.settled.has('V1')).toBe(false);
          expect(result.runs).toEqual([expect.objectContaining({ checkId: 'V1', status: 'fail' })]);
          expect(result.runs[0]?.preExisting).toBeUndefined();
        }
      },
    );
  });
});

describe('runTaskChecks for a fix task that answers a reviewer check', { timeout: 60_000 }, () => {
  const FILES = {
    'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    'src/a.ts': 'export const a = 1;\n',
  };
  const OWN_RED = 'src/a.ts(1,14): error TS2322: Type number is not assignable to type string.';
  const OWN_KEY = OWN_RED;
  const OTHER_RED = 'src/b.ts(3,7): error TS2322: Type number is not assignable to type string.';
  const OTHER_RED_2 = 'src/c.ts(9,1): error TS2304: Cannot find name x.';

  it('keeps a reviewer command pending once across fix tasks from an earlier cycle', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-check-pending' }, async (run) => {
      const task = makeTask({
        id: 'T002',
        fix: {
          cycle: 1,
          findings: [
            {
              id: 'V1.1',
              text: 'Reviewer check V1 failed.',
              acceptance: null,
              checkIds: ['V1'],
              commands: { V1: 'npm test' },
            },
          ],
        },
      });
      const secondTask = makeTask({ ...task, id: 'T003' });
      const ref = { projectDir: run.dir, sessionId: run.sessionId };
      const wctx = makeWctx({ ...ref, workspaceDir: run.ws, config: makeConfig() });
      const setTrackedState = vi.fn();
      const first = await runTaskChecks({
        wctx,
        state: makeImplState([task, secondTask], {
          workspace: run.workspace,
          fixCycles: { used: 2, allowance: 2, notes: [] },
          pendingReviewCommands: ['node --version'],
        }),
        task,
        checkIds: ['V1'],
        runCommand: makeCommandRunner(),
        setTrackedState,
      });
      expect(first.runs[0]?.status).toBe('pass');
      expect(first.state.pendingReviewCommands).toEqual(['node --version', 'npm test']);
      const second = await runTaskChecks({
        wctx,
        state: first.state,
        task: secondTask,
        checkIds: ['V1'],
        runCommand: makeCommandRunner(
          processError.exitCode({ command: 'npm test', code: 1, stderr: '', output: OWN_RED }),
        ),
        setTrackedState,
      });
      expect(second.runs[0]?.status).toBe('fail');
      expect(second.state.pendingReviewCommands).toEqual(['node --version', 'npm test']);
      expect(loadState(ref)?.pendingReviewCommands).toEqual(['node --version', 'npm test']);
      expect(setTrackedState).toHaveBeenLastCalledWith(second.state);
    });
  });

  /**
   * Runs the fix task's K1 and the V1 it answers; `red` answers `npm test` in each place. `keys` are
   * the failure keys the finding carries for V1; null is an older fix task saved without them.
   */
  async function fixChecks(
    run: ApplyRun,
    red: (at: 'workspace' | 'base') => string | null,
    keys: string[] | null = [OWN_KEY],
  ) {
    const task = makeTask({
      id: 'T002',
      checks: versionCheck(),
      fix: {
        cycle: 1,
        findings: [
          {
            id: 'V1.1',
            text: 'Reviewer check V1 (npm test) failed with new failures.',
            acceptance: null,
            file: 'src/a.ts',
            checkIds: ['V1'],
            commands: { V1: 'npm test' },
            output: OWN_RED,
            ...(keys !== null && {
              failureKeys: { V1: keys },
              redKeys: { V1: [...keys, OTHER_RED, OTHER_RED_2] },
            }),
          },
        ],
      },
    });
    const state = makeImplState([task], { workspace: run.workspace });
    const ref = { projectDir: run.dir, sessionId: run.sessionId };
    saveState(ref, state);
    const places: Array<'workspace' | 'base'> = [];
    const runCommand: ValidationCommandRunner = async (cmd, args, options) => {
      const command = [cmd, ...args].join(' ');
      const at = options?.cwd === run.ws ? 'workspace' : 'base';
      if (command === 'npm test') places.push(at);
      const output = command === 'npm test' ? red(at) : null;
      if (output === null) return { stdout: 'ok', stderr: '', code: 0 };
      throw processError.exitCode({
        command,
        code: 1,
        stderr: '',
        output,
      });
    };
    const { bus, events } = makeBusRecorder();
    const result = await runTaskChecks({
      wctx: makeWctx({ ...ref, workspaceDir: run.ws, bus, config: makeConfig() }),
      state,
      task,
      checkIds: ['K1', 'V1'],
      runCommand,
    });
    const rows = events.filter(
      (event): event is EngineEventOf<'full_suite'> => event.type === 'full_suite',
    );
    return { result, rows, events, places };
  }

  // Live run 2026-10-09: T013 fixed its own errors and stayed red on the errors T014-T017 own.
  it('settles a fix check once the failures it carries are gone, when an original other failure stays red', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-check-own-gone' }, async (run) => {
      const { result, rows, places } = await fixChecks(run, () => `${OTHER_RED}\n${OTHER_RED_2}`);

      expect(places).toEqual(['workspace']);
      expect(rows.map((row) => [row.id, row.moment, row.status, row.passed])).toEqual([
        ['V1', 'brief', 'running', undefined],
        ['V1', 'brief', 'done', true],
      ]);
      expect(rows[1]).toMatchObject({ own: 1, ownLeft: 0, others: 2 });
      expect(rows[1]?.duration).toEqual(expect.any(Number));
      expect(result.runs.map((entry) => [entry.checkId, entry.status])).toEqual([
        ['K1', 'pass'],
        ['V1', 'fail'],
      ]);
      expect(result.settled.has('V1')).toBe(true);
    });
  });

  it('does not settle a fix check while a failure it carries remains, and runs nothing at the run base', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-check-own-left' }, async (run) => {
      const { result, rows, places } = await fixChecks(run, () => `${OWN_RED}\n${OTHER_RED}`);

      expect(places).toEqual(['workspace']);
      expect(rows.map((row) => [row.moment, row.status, row.passed])).toEqual([
        ['brief', 'running', undefined],
        ['brief', 'done', false],
      ]);
      expect(rows[1]).toMatchObject({ own: 1, ownLeft: 1, others: 1 });
      expect(result.settled.has('V1')).toBe(false);
    });
  });

  it('keeps a carried failure that only the head of a long output names', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-check-long' }, async (run) => {
      const noise = Array.from(
        { length: 200 },
        (_, index) => `    Type 'Section<${index}>' is not assignable to type 'Section<never>'.`,
      ).join('\n');
      const { result, rows } = await fixChecks(run, () => `${OWN_RED}\n${noise}\n${OTHER_RED}`);

      expect(rows.at(-1)).toMatchObject({ moment: 'brief', passed: false, own: 1, ownLeft: 1 });
      expect(result.settled.has('V1')).toBe(false);
    });
  });

  it('does not settle a fix check when a carried diagnostic moves to another line', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-check-line-moved' }, async (run) => {
      const moved = OWN_RED.replace('(1,14)', '(2,14)');
      const { result, rows, places } = await fixChecks(run, () => `${moved}\n${OTHER_RED}`);

      expect(places).toEqual(['workspace']);
      expect(rows.at(-1)).toMatchObject({
        moment: 'brief',
        status: 'done',
        passed: false,
        own: 1,
        ownLeft: 1,
        others: 1,
      });
      expect(result.settled.has('V1')).toBe(false);
    });
  });

  it('holds an older fix task that carries no failure keys to a passing command', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-check-no-keys' }, async (run) => {
      const { result, rows, places } = await fixChecks(run, () => OTHER_RED, null);

      expect(places).toEqual(['workspace']);
      expect(rows.map((row) => [row.moment, row.status, row.passed])).toEqual([
        ['brief', 'running', undefined],
        ['brief', 'done', false],
      ]);
      expect(rows[1]).not.toHaveProperty('own');
      expect(result.settled.has('V1')).toBe(false);
    });
  });

  it('records a settled fix check as passed while preserving its red command evidence', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-check-recorded' }, async (run) => {
      const { result, events } = await fixChecks(run, () => OTHER_RED);

      expect(result.state.tasks[0]?.checkResults).toEqual([
        { id: 'K1', status: 'pass' },
        { id: 'V1', status: 'pass' },
      ]);
      expect(events.filter((event) => event.type === 'checks_run')).toEqual([
        expect.objectContaining({
          results: [
            { id: 'K1', status: 'pass' },
            { id: 'V1', status: 'pass' },
          ],
        }),
      ]);
      expect(
        recordedChecks(run.dir, run.sessionId).find((check) => check.id === 'V1'),
      ).toMatchObject({ exitCode: 1, output: OTHER_RED });
    });
  });

  it('settles a plan check a fix finding carries by the same keys and says so on a fix check row', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-plan-check' }, async (run) => {
      const typecheck: Check = { id: 'K2', kind: 'cmd', value: 'tsc --noEmit', required: true };
      const task = makeTask({
        id: 'T002',
        checks: [typecheck],
        fix: {
          cycle: 1,
          findings: [
            {
              id: 'P1',
              text: 'Required check K2 failed.',
              acceptance: null,
              file: 'src/a.ts',
              checkIds: ['K2'],
              commands: { K2: 'tsc --noEmit' },
              output: OWN_RED,
              failureKeys: { K2: [OWN_KEY] },
              redKeys: { K2: [OWN_KEY, OTHER_RED] },
            },
          ],
        },
      });
      const ref = { projectDir: run.dir, sessionId: run.sessionId };
      const state = makeImplState([task], { workspace: run.workspace });
      saveState(ref, state);
      const { bus, events } = makeBusRecorder();
      const settledFor = async (output: string) =>
        runTaskChecks({
          wctx: makeWctx({ ...ref, workspaceDir: run.ws, bus, config: makeConfig() }),
          state,
          task,
          checkIds: ['K2'],
          runCommand: makeCommandRunner(
            processError.exitCode({ command: 'tsc --noEmit', code: 2, stderr: '', output }),
          ),
        });

      expect((await settledFor(OTHER_RED)).settled.has('K2')).toBe(true);
      expect((await settledFor(`${OWN_RED}\n${OTHER_RED}`)).settled.has('K2')).toBe(false);
      expect(events.filter((event) => event.type === 'full_suite')).toEqual([
        {
          type: 'full_suite',
          ts: expect.any(Number),
          phase: state.phase,
          status: 'done',
          id: 'K2',
          command: 'tsc --noEmit',
          moment: 'brief',
          passed: true,
          own: 1,
          ownLeft: 0,
          others: 1,
          proven: true,
        },
        {
          type: 'full_suite',
          ts: expect.any(Number),
          phase: state.phase,
          status: 'done',
          id: 'K2',
          command: 'tsc --noEmit',
          moment: 'brief',
          passed: false,
          own: 1,
          ownLeft: 1,
          others: 1,
          proven: true,
        },
      ]);
    });
  });

  it('does not settle a red that only shows new failures', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-check-not-proven' }, async (run) => {
      const fresh = 'src/first.ts(1,1): error TS2322: New first-stage error.';
      const { result, rows } = await fixChecks(run, () => fresh);
      expect(result.settled.has('V1')).toBe(false);
      expect(result.state.tasks[0]?.checkResults).toContainEqual({ id: 'V1', status: 'fail' });
      expect(rows.at(-1)).toMatchObject({
        passed: false,
        own: 1,
        ownLeft: 0,
        others: 1,
        proven: false,
      });
    });
  });

  it.each(['plan', 'task'] as const)(
    'publishes a green %s check ownership verdict',
    async (origin) => {
      await withApplyRun(FILES, { sessionId: 'sess-green-fix-check' }, async (run) => {
        const check: Check = { id: 'K2', kind: 'cmd', value: 'tsc --noEmit', required: true };
        const task = makeTask({
          checks: origin === 'task' ? [check] : [],
          fix: {
            cycle: 1,
            findings: [
              {
                id: 'P1',
                text: 'Red check',
                acceptance: null,
                checkIds: ['K2'],
                failureKeys: { K2: [OWN_RED] },
                redKeys: { K2: [OWN_RED] },
              },
            ],
          },
        });
        const state = makeImplState([task], {
          workspace: run.workspace,
          plan:
            origin === 'plan'
              ? { summary: 'Fix', decisions: [], criteria: [], checks: [check], validation: null }
              : undefined,
        });
        const { bus, events } = makeBusRecorder();
        const result = await runTaskChecks({
          wctx: makeWctx({
            projectDir: run.dir,
            sessionId: run.sessionId,
            workspaceDir: run.ws,
            bus,
            config: makeConfig(),
          }),
          state,
          task,
          checkIds: ['K2'],
          runCommand: makeCommandRunner(),
        });
        expect(result.state.tasks[0]?.checkResults).toContainEqual({ id: 'K2', status: 'pass' });
        expect(events.filter((event) => event.type === 'full_suite')).toEqual([
          expect.objectContaining({
            id: 'K2',
            status: 'done',
            moment: 'brief',
            own: 1,
            ownLeft: 0,
            others: 0,
            proven: true,
          }),
        ]);
      });
    },
  );

  it('runs a fix check with the real HOME and without the host secrets', async () => {
    const probe = [
      'const secrets = ["OPENAI_API_KEY", "GITHUB_TOKEN", "SSH_AUTH_SOCK"];',
      'const seen = secrets.filter((name) => process.env[name] !== undefined);',
      'console.log("home " + process.env.HOME);',
      'console.log("seen " + (seen.length === 0 ? "none" : seen.join(" ")));',
    ].join('\n');
    const files = {
      'package.json': JSON.stringify({ scripts: { test: 'node probe.cjs' } }),
      'probe.cjs': probe,
    };
    await withApplyRun(files, { sessionId: 'sess-fix-check-env' }, async (run) => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-fix-check-canary');
      vi.stubEnv('GITHUB_TOKEN', 'ghp-fix-check-canary');
      vi.stubEnv('SSH_AUTH_SOCK', '/tmp/fix-check-canary.sock');
      const task = makeTask({
        id: 'T002',
        fix: {
          cycle: 1,
          findings: [
            {
              id: 'V1.1',
              text: 'Reviewer check V1 (npm test) failed.',
              acceptance: null,
              checkIds: ['V1'],
              commands: { V1: 'npm test' },
            },
          ],
        },
      });
      const result = await runTaskChecks({
        wctx: makeWctx({
          projectDir: run.dir,
          sessionId: run.sessionId,
          workspaceDir: run.ws,
          config: makeConfig(),
        }),
        state: makeImplState([task], { workspace: run.workspace }),
        task,
        checkIds: ['V1'],
      });

      expect(result.runs).toEqual([expect.objectContaining({ checkId: 'V1', status: 'pass' })]);
      expect(result.runs[0]?.output).toContain(`home ${process.env.HOME}`);
      expect(result.runs[0]?.output).toContain('seen none');
    });
  });

  it('refuses a fix check the reviewer command policy refuses and runs nothing', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-check-policy' }, async (run) => {
      const task = makeTask({
        id: 'T002',
        fix: {
          cycle: 1,
          findings: [
            {
              id: 'V1.1',
              text: 'Reviewer check V1 failed.',
              acceptance: null,
              checkIds: ['V1'],
              commands: { V1: 'npm install' },
            },
          ],
        },
      });
      const runner = makeCommandRunner();
      const { bus, events } = makeBusRecorder();
      const result = await runTaskChecks({
        wctx: makeWctx({
          projectDir: run.dir,
          sessionId: run.sessionId,
          workspaceDir: run.ws,
          bus,
          config: makeConfig(),
        }),
        state: makeImplState([task], { workspace: run.workspace }),
        task,
        checkIds: ['V1'],
        runCommand: runner,
      });

      expect(runner.calls).toEqual([]);
      expect(result.runs).toEqual([
        expect.objectContaining({ checkId: 'V1', status: 'refused', command: 'npm install' }),
      ]);
      expect(result.settled.has('V1')).toBe(false);
      expect(result.state.pendingReviewCommands).toBeUndefined();
      expect(
        events
          .filter((event): event is EngineEventOf<'full_suite'> => event.type === 'full_suite')
          .map((row) => [row.id, row.moment, row.status]),
      ).toEqual([
        ['V1', 'brief', 'running'],
        ['V1', 'brief', 'refused'],
      ]);
    });
  });

  it('publishes a refused fix check with its reason and runs nothing at the run base', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-fix-check-refused' }, async (run) => {
      writeFileSync(
        join(run.ws, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run --passWithNoTests' } }),
      );
      const { rows } = await fixChecks(run, () => null);

      expect(rows.map((row) => [row.id, row.moment, row.status])).toEqual([
        ['V1', 'brief', 'running'],
        ['V1', 'brief', 'refused'],
      ]);
      expect(rows[1]?.detail).toEqual(expect.stringContaining('which this run changed'));
    });
  });
});
