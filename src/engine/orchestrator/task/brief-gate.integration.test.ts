import { plainUserMessage } from '../../../core/types/user-input.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeConfig, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { withApplyRun, type ApplyRun } from '#testing/helpers/apply-run.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue-state.js';
import { processError } from '../../../lib/process/errors.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { clearPendingQueue } from '../queue/clear.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { CORRECTION_AFTER_CHECKS, runBriefGate } from './brief-gate.js';

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
  it.each([
    { name: 'green checks with a pending message', green: true, queued: true },
    { name: 'green checks without a message', green: true, queued: false },
    { name: 'red checks with a pending message', green: false, queued: true },
  ])('returns the gate result for $name', async ({ green, queued }) => {
    const ref = setup();
    const task = makeTask({
      id: 'T001',
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
    });
    const state = makeImplState([task]);
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const runCommand: ValidationCommandRunner = async () => {
      if (queued) {
        enqueueUserMessage({
          ...ref,
          state,
          message: plainUserMessage('keep the public name'),
          phase: state.phase,
          bus,
        });
      }
      if (!green) {
        throw processError.exitCode({ command: 'node', code: 1, stderr: 'broken' });
      }
      return { stdout: 'ok', stderr: '', code: 0 };
    };

    const result = await runBriefGate({
      wctx: makeWctx({
        ...ref,
        bus,
        config: makeNoValidationConfig({ workflow: { review: 'task' } }),
      }),
      state,
      task,
      changedFiles: [],
      taskStartSnapshot: null,
      runCommand,
    });

    expect(result.acceptance.accepted).toBe(green && !queued);
    expect(result.correction).toBe(green && queued);
    if (green) expect(result.error).toBe(queued ? CORRECTION_AFTER_CHECKS : '');
    else expect(result.error).toMatch(/^check K1 did not pass \(fail\): broken/);
    expect(result.diagnosis).toBe(green ? '' : 'check K1 failed');
    expect(result.state.tasks[0]?.checkResults).toEqual([
      { id: 'K1', status: green ? 'pass' : 'fail' },
    ]);
    expect(result.state.messageQueue.filter(isQueuedMessagePendingDelivery)).toHaveLength(
      queued ? 1 : 0,
    );
    expect(events.filter((event) => event.type === 'queue_drained')).toEqual([]);
  });

  it('reads a message persisted after the checks are recorded before accepting', async () => {
    const ref = setup();
    const task = makeTask({
      id: 'T001',
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
    });
    const state = makeImplState([task]);
    saveState(ref, state);
    const { bus } = makeBusRecorder();
    bus.subscribe((event) => {
      if (event.type === 'checks_run') {
        enqueueUserMessage({
          ...ref,
          state,
          message: plainUserMessage('also update the alias'),
          phase: state.phase,
          bus,
        });
      }
    });

    const result = await runBriefGate({
      wctx: makeWctx({
        ...ref,
        bus,
        config: makeNoValidationConfig({ workflow: { review: 'task' } }),
      }),
      state,
      task,
      changedFiles: [],
      taskStartSnapshot: null,
      runCommand: async () => ({ stdout: 'ok', stderr: '', code: 0 }),
    });

    expect(result.correction).toBe(true);
    expect(result.acceptance.accepted).toBe(false);
    expect(result.state.messageQueue[0]?.text).toBe('also update the alias');
    expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'K1', status: 'pass' }]);
  });

  it('accepts when a correction is cleared after the checks are recorded', async () => {
    const ref = setup();
    const task = makeTask({
      id: 'T001',
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
    });
    const state = makeImplState([task]);
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    bus.subscribe((event) => {
      if (event.type !== 'checks_run') return;
      const checked = loadState(ref);
      if (checked === null) throw new Error('missing recorded checks');
      clearPendingQueue({ ...ref, state: checked, bus });
    });

    const result = await runBriefGate({
      wctx: makeWctx({
        ...ref,
        bus,
        config: makeNoValidationConfig({ workflow: { review: 'task' } }),
      }),
      state,
      task,
      changedFiles: [],
      taskStartSnapshot: null,
      runCommand: async () => {
        enqueueUserMessage({
          ...ref,
          state,
          message: plainUserMessage('cleared correction'),
          phase: state.phase,
          bus,
        });
        return { stdout: 'ok', stderr: '', code: 0 };
      },
    });

    expect(events.filter((event) => event.type === 'queue_cleared')).toHaveLength(1);
    expect(result.correction).toBe(false);
    expect(result.acceptance).toEqual({ accepted: true });
    expect(result.error).toBe('');
    expect(result.state.messageQueue).toEqual([]);
    expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'K1', status: 'pass' }]);
    expect(loadState(ref)?.messageQueue).toEqual([]);
  });

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
    expect(result.acceptance).toEqual({ accepted: true });
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
    expect(due.state.tasks[1]?.checkResults).toEqual([{ id: 'K1', status: 'pass' }]);
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
      expect(result.acceptance).toEqual({ accepted: !required });
      expect(result.error).toMatch(required ? /^check K1 did not pass \(fail\): .*broken/s : /^$/);
      expect(result.diagnosis).toBe(required ? 'check K1 failed' : '');
      expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'K1', status: 'fail' }]);
    }
  });
  // Live run 2026-10-09: the 4k tail of `npm run test-ci` was an event-log line.
  it('leads the retry text with the failing test and its message when the output tail is noise', async () => {
    const ref = setup();
    const noise = Array.from(
      { length: 200 },
      (_line, index) => `{"type":"task_end","id":${index},"endedAt":1760000000000,"durationMs":63}`,
    );
    const output = [
      ' FAIL  src/a.test.ts > a > adds',
      'AssertionError: expected 1 to be 2',
      ' ❯ src/a.test.ts:3:5',
      ...noise,
    ].join('\n');
    const task = makeTask({
      id: 'T001',
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
    });
    const result = await runBriefGate({
      wctx: makeWctx({ ...ref, config: makeNoValidationConfig({ workflow: { review: 'task' } }) }),
      task,
      state: makeImplState([task]),
      changedFiles: [],
      taskStartSnapshot: null,
      runCommand: vi
        .fn()
        .mockRejectedValue(processError.exitCode({ command: 'node', code: 1, stderr: output })),
    });
    expect(result.acceptance).toEqual({ accepted: false });
    expect(result.error).toMatch(
      /^check K1 did not pass \(fail\): 1 failure\nFailures:\n- src\/a\.test\.ts::a > adds\n {2}AssertionError: expected 1 to be 2\nOutput tail:\n/,
    );
    expect(result.error.endsWith(noise.at(-1) ?? '')).toBe(true);
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
            text: 'No task changed it.\nRequired check K1 did not pass (fail): broken',
            acceptance: null,
            checkIds: ['K1'],
            commands: { K1: 'node --version' },
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

  it('fails the gate on a fix check that does not pass, whatever its status', async () => {
    const ref = setup();
    const missing = Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' });
    const cases = [
      { finding: { checkIds: ['V2'] }, status: 'unknown' },
      { finding: { checkIds: ['V1'], commands: { V1: 'node --version' } }, status: 'not-runnable' },
    ];
    for (const { finding, status } of cases) {
      const task = makeTask({
        id: 'T003',
        fix: {
          cycle: 1,
          findings: [{ id: 'F1', text: 'the reviewer check is red', acceptance: null, ...finding }],
        },
      });
      const result = await runBriefGate({
        wctx: makeWctx(ref),
        state: makeImplState([task]),
        task,
        changedFiles: [],
        taskStartSnapshot: null,
        runCommand: vi.fn().mockRejectedValue(missing),
      });
      expect(result.acceptance).toEqual({ accepted: false });
      expect(result.error).toContain(`did not pass (${status})`);
    }
  });

  it('accepts a fix finding after both carried reviewer commands pass', async () => {
    const ref = setup();
    const task = makeTask({
      id: 'T003',
      fix: {
        cycle: 1,
        findings: [
          {
            id: 'F1',
            text: 'Both reviewer checks failed',
            acceptance: null,
            checkIds: ['V1', 'V2'],
            commands: { V1: 'node --version', V2: 'tsc --noEmit' },
          },
        ],
      },
    });
    const runCommand = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 });
    const result = await runBriefGate({
      wctx: makeWctx(ref),
      state: makeImplState([task]),
      task,
      changedFiles: [],
      taskStartSnapshot: null,
      runCommand,
    });

    expect(runCommand.mock.calls.map(([cmd, args]) => [cmd, ...args].join(' '))).toEqual([
      'node --version',
      'tsc --noEmit',
    ]);
    expect(result.acceptance).toEqual({ accepted: true });
    expect(result.state.tasks[0]?.checkResults).toEqual([
      { id: 'V1', status: 'pass' },
      { id: 'V2', status: 'pass' },
    ]);
  });

  describe('a fix task that answers a reviewer check', { timeout: 60_000 }, () => {
    const NEW_RED = 'src/a.ts(1,14): error TS2322: Type number is not assignable to type string.';
    const NEW_KEY = NEW_RED;
    const OLD_RED =
      'src/legacy.ts(3,7): error TS2322: Type number is not assignable to type string.';

    type GateOptions = {
      /** The command the newest review recorded as V1; a later review may have chosen another. */
      recorded?: string;
      config?: ReturnType<typeof makeConfig>;
      /** The failure keys the finding carries for V1; null is an older fix task saved without them. */
      keys?: string[] | null;
    };

    /** Runs the fix task's gate on a real run workspace and run base; `red` answers each place. */
    async function gate(
      run: ApplyRun,
      red: (at: 'workspace' | 'base') => string | null,
      options: GateOptions = {},
    ) {
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
              commands: { V1: 'npm test' },
              output: NEW_RED,
              ...(options.keys !== null && {
                failureKeys: { V1: options.keys ?? [NEW_KEY] },
                redKeys: { V1: [...(options.keys ?? [NEW_KEY]), OLD_RED] },
              }),
            },
          ],
        },
      });
      const reviewChecks = {
        scope: 'task' as const,
        cycle: 1,
        plan: {
          commands: [
            { id: 'V1', command: options.recorded ?? 'npm test', reason: 'verifies the change' },
          ],
          declined: [],
          reason: null,
        },
        at: '2026-10-08T00:00:00.000Z',
      };
      const state = makeImplState([task], { workspace: run.workspace, reviewChecks });
      const ref = { projectDir: run.dir, sessionId: run.sessionId };
      saveState(ref, state);
      const places: Array<'workspace' | 'base'> = [];
      const commands: string[] = [];
      const runCommand: ValidationCommandRunner = async (cmd, args, options) => {
        const at = options?.cwd === run.ws ? 'workspace' : 'base';
        places.push(at);
        commands.push([cmd, ...args].join(' '));
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
          config: options.config ?? makeConfig(),
          validator: { formatChangedFiles: vi.fn().mockResolvedValue(undefined) },
        }),
        state,
        task,
        changedFiles: ['src/a.ts'],
        taskStartSnapshot: null,
        runCommand,
      });
      return { result, places, commands };
    }

    it('fails the gate while a failure the finding carries remains, and runs nothing at the run base', async () => {
      await withApplyRun(FILES, { sessionId: 'sess-fix-new-red' }, async (run) => {
        const { result, places } = await gate(run, (at) =>
          at === 'workspace' ? `${NEW_RED}\n${OLD_RED}` : null,
        );

        expect(places).toEqual(['workspace']);
        expect(result.acceptance.accepted).toBe(false);
        expect(result.error).toMatch(/^check V1 did not pass \(fail\): .*TS2322/s);
        expect(result.error).toContain(
          `your 1\u00a0failure remains\nYour failures that remain:\n- ${NEW_KEY}\nOther failures:\n- ${OLD_RED}\nOutput tail:`,
        );
        expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'V1', status: 'fail' }]);
      });
    });

    // Live run 2026-10-09: T013 retried on the errors T014-T017 own.
    it('accepts the gate once the failures the finding carries are gone, whatever else stays red', async () => {
      await withApplyRun(FILES, { sessionId: 'sess-fix-own-gone' }, async (run) => {
        const { result, places } = await gate(run, () => OLD_RED);

        expect(places).toEqual(['workspace']);
        expect(result.acceptance.accepted).toBe(true);
        expect(result.error).toBe('');
        expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'V1', status: 'pass' }]);
      });
    });

    it('holds an older fix task saved without failure keys to a passing command', async () => {
      await withApplyRun(FILES, { sessionId: 'sess-fix-no-keys' }, async (run) => {
        const { result, places } = await gate(run, () => OLD_RED, { keys: null });

        expect(places).toEqual(['workspace']);
        expect(result.acceptance.accepted).toBe(false);
        expect(result.error).toMatch(/^check V1 did not pass \(fail\): .*legacy/s);
      });
    });

    it('runs the command the finding carries, not the V1 a later review recorded', async () => {
      await withApplyRun(FILES, { sessionId: 'sess-fix-carried' }, async (run) => {
        const { result, places, commands } = await gate(
          run,
          (at) => (at === 'workspace' ? NEW_RED : null),
          { recorded: 'node --version' },
        );

        expect(places).toEqual(['workspace']);
        expect(commands).toEqual(['npm test']);
        expect(result.acceptance.accepted).toBe(false);
        expect(result.error).toMatch(/^check V1 did not pass \(fail\): .*TS2322/s);
      });
    });

    it('runs the carried command again while End-of-run checks are off', async () => {
      await withApplyRun(FILES, { sessionId: 'sess-fix-off' }, async (run) => {
        const { result, commands } = await gate(
          run,
          (at) => (at === 'workspace' ? NEW_RED : null),
          { config: makeConfig({ validation: { endChecks: false } }) },
        );

        expect(commands).toEqual(['npm test']);
        expect(result.acceptance.accepted).toBe(false);
      });
    });

    it('refuses the carried command and fails the gate when the fix changed its script', async () => {
      await withApplyRun(FILES, { sessionId: 'sess-fix-script' }, async (run) => {
        writeFileSync(
          join(run.ws, 'package.json'),
          JSON.stringify({ scripts: { test: 'vitest run --passWithNoTests' } }),
        );
        const { result, places } = await gate(run, () => null);

        expect(places).toEqual([]);
        expect(result.acceptance.accepted).toBe(false);
        expect(result.error).toMatch(/^check V1 did not pass \(refused\): /);
        expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'V1', status: 'refused' }]);
      });
    });
  });
});
