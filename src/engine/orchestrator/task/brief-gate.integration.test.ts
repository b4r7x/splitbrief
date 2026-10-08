import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeConfig, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { withApplyRun, type ApplyRun } from '#testing/helpers/apply-run.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { saveState } from '../../../core/state/persistence.js';
import { processError } from '../../../lib/process/errors.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { runBriefGate } from './brief-gate.js';

const FILES = {
  'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
  'src/a.ts': 'export const a = 1;\n',
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function setup() {
  const ref = setupGitSessionProject({ prefix: 'brief-gate', sessionId: 'sess-gate' });
  dirs.push(ref.projectDir);
  return ref;
}

describe('brief gate', () => {
  it('accepts end cadence with no check run and still formats its own files', async () => {
    const ref = setup();
    const task = makeTask({ id: 'T001' });
    const { bus, events } = makeBusRecorder();
    const validator = { formatChangedFiles: vi.fn().mockResolvedValue(undefined) };
    const result = await runBriefGate({
      wctx: makeWctx({ ...ref, bus, validator }),
      state: makeImplState([task]),
      task,
      changedFiles: ['src/own.ts'],
      taskStartSnapshot: null,
    });
    expect(result.acceptance.accepted).toBe(true);
    expect(result.validationResults).toEqual([]);
    expect(validator.formatChangedFiles).toHaveBeenCalledWith(
      expect.objectContaining({ changedFiles: ['src/own.ts'] }),
    );
    expect(
      events.filter((event) => event.type === 'validate' || event.type === 'checks_run'),
    ).toEqual([]);
  });

  it('runs a shared criterion check only when the last task serving it hands back', async () => {
    const ref = setup();
    const first = makeTask({ id: 'T001', criteria: ['C1'] });
    const last = makeTask({ id: 'T002', criteria: ['C1'] });
    const plan = {
      summary: 'shared criterion',
      decisions: [],
      validation: null,
      criteria: [{ id: 'C1', text: 'both work', checkIds: ['K1'] }],
      checks: [{ id: 'K1', kind: 'cmd' as const, value: 'node --version', required: true }],
    };
    const runCommand = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 });
    const wctx = makeWctx({
      ...ref,
      config: makeNoValidationConfig({ workflow: { review: 'task' } }),
    });
    const early = await runBriefGate({
      wctx,
      task: first,
      state: makeImplState([first, last], { plan }),
      changedFiles: [],
      taskStartSnapshot: null,
      runCommand,
    });
    expect(early.state.tasks[0]?.checkResults).toBeUndefined();
    expect(runCommand).not.toHaveBeenCalled();
    const due = await runBriefGate({
      wctx,
      task: last,
      state: makeImplState([{ ...first, status: 'done' }, last], { plan }),
      changedFiles: [],
      taskStartSnapshot: null,
      runCommand,
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(due.state.tasks[1]?.checkResults).toEqual([{ id: 'K1', passed: true }]);
  });

  it('rejects required due checks and accepts optional failures', async () => {
    const ref = setup();
    const runCommand = vi
      .fn()
      .mockRejectedValue(
        processError.exitCode({ command: 'node', code: 1, stderr: 'src/own.ts(2,1): broken' }),
      );
    const wctx = makeWctx({
      ...ref,
      config: makeNoValidationConfig({ workflow: { review: 'task' } }),
    });
    for (const required of [true, false]) {
      const task = makeTask({
        id: 'T001',
        checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required }],
      });
      const result = await runBriefGate({
        wctx,
        task,
        state: makeImplState([task]),
        changedFiles: [],
        taskStartSnapshot: null,
        runCommand,
      });
      expect(result.acceptance.accepted).toBe(!required);
      expect(result.validationResults).toEqual([]);
      expect(result.acceptance.blockingStages).toEqual([]);
      expect(result.error).toMatch(required ? /^check K1 did not pass \(fail\): .*broken/s : /^$/);
      expect(result.diagnosis).toBe(required ? 'check K1 failed' : '');
      expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'K1', passed: false }]);
    }
  });
  it('runs the check of the red a fix task answers again at end cadence, and a red fails the gate', async () => {
    const ref = setup();
    const task = makeTask({
      id: 'T004',
      fix: {
        cycle: 1,
        findings: [
          {
            id: 'P1',
            text: 'Required check K1 failed: broken No task changed it.',
            acceptance: null,
            checkIds: ['K1'],
            command: 'node --version',
            output: 'broken',
          },
        ],
      },
    });
    const plan = {
      summary: 'fix',
      decisions: [],
      validation: null,
      criteria: [],
      checks: [{ id: 'K1', kind: 'cmd' as const, value: 'node --version', required: false }],
    };
    const runCommand = vi
      .fn()
      .mockRejectedValue(processError.exitCode({ command: 'node', code: 1, stderr: 'broken' }));
    const result = await runBriefGate({
      wctx: makeWctx(ref),
      state: makeImplState([task], { plan }),
      task,
      changedFiles: ['src/own.ts'],
      taskStartSnapshot: null,
      runCommand,
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(result.acceptance.accepted).toBe(false);
    expect(result.error).toMatch(/^check K1 did not pass \(fail\): broken/);
    expect(result.diagnosis).toBe('check K1 failed');
  });

  describe('a fix task that answers a reviewer check', { timeout: 60_000 }, () => {
    const NEW_RED = 'src/a.ts(1,14): error TS2322: Type number is not assignable to type string.';
    const OLD_RED =
      'src/legacy.ts(3,7): error TS2322: Type number is not assignable to type string.';

    /** Runs the fix task's gate on a real run workspace and run base; `red` answers each place. */
    async function gate(run: ApplyRun, red: (at: 'workspace' | 'base') => string | null) {
      const task = makeTask({
        id: 'T002',
        fix: {
          cycle: 1,
          findings: [
            {
              id: 'V1.1',
              text: 'Reviewer check V1 (npm test) failed with new failures.',
              acceptance: null,
              file: 'src/a.ts',
              checkIds: ['V1'],
              command: 'npm test',
              output: NEW_RED,
            },
          ],
        },
      });
      const reviewChecks = {
        scope: 'final' as const,
        cycle: 0,
        plan: {
          commands: [{ id: 'V1', command: 'npm test', reason: 'verifies the change' }],
          declined: [],
          reason: null,
        },
        at: '2026-10-08T00:00:00.000Z',
      };
      const state = makeImplState([task], { workspace: run.workspace, reviewChecks });
      const ref = { projectDir: run.dir, sessionId: run.sessionId };
      saveState(ref, state);
      const places: Array<'workspace' | 'base'> = [];
      const runCommand: ValidationCommandRunner = async (cmd, args, options) => {
        const at = options?.cwd === run.ws ? 'workspace' : 'base';
        places.push(at);
        const output = red(at);
        if (output === null) return { stdout: 'ok', stderr: '', code: 0 };
        throw processError.exitCode({
          command: [cmd, ...args].join(' '),
          code: 1,
          stderr: '',
          output,
        });
      };
      const result = await runBriefGate({
        wctx: makeWctx({
          ...ref,
          workspaceDir: run.ws,
          config: makeConfig(),
          validator: { formatChangedFiles: vi.fn().mockResolvedValue(undefined) },
        }),
        state,
        task,
        changedFiles: ['src/a.ts'],
        taskStartSnapshot: null,
        runCommand,
      });
      return { result, places };
    }

    it('fails the gate while the command still shows a failure the run base does not', async () => {
      await withApplyRun(FILES, { sessionId: 'sess-fix-new-red' }, async (run) => {
        const { result, places } = await gate(run, (at) => (at === 'workspace' ? NEW_RED : null));

        expect(places).toEqual(['workspace', 'base']);
        expect(result.acceptance.accepted).toBe(false);
        expect(result.error).toMatch(/^check V1 did not pass \(fail\): .*TS2322/s);
        expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'V1', passed: false }]);
      });
    });

    it('accepts the gate when every failure left is also red at the run base', async () => {
      await withApplyRun(FILES, { sessionId: 'sess-fix-old-red' }, async (run) => {
        const { result, places } = await gate(run, () => OLD_RED);

        expect(places).toEqual(['workspace', 'base']);
        expect(result.acceptance.accepted).toBe(true);
        expect(result.error).toBe('');
      });
    });
  });
});
