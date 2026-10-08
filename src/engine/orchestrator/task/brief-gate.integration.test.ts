import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createValidator } from '../validation/run.js';
import { processError } from '../../../lib/process/errors.js';
import { runBriefGate } from './brief-gate.js';

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
  it('accepts end cadence with no validation event and still formats its own files', async () => {
    const ref = setup();
    const task = makeTask({ id: 'T001' });
    const { bus, events } = makeBusRecorder();
    const validator = {
      ...createValidator(),
      formatChangedFiles: vi.fn().mockResolvedValue(undefined),
      runValidation: vi.fn(),
    };
    const result = await runBriefGate({
      wctx: makeWctx({ ...ref, bus, validator }),
      state: makeImplState([task]),
      task,
      changedFiles: ['src/own.ts'],
      taskStartSnapshot: null,
    });
    expect(result.acceptance.accepted).toBe(true);
    expect(result.validationResults).toEqual([]);
    expect(validator.runValidation).not.toHaveBeenCalled();
    expect(validator.formatChangedFiles).toHaveBeenCalledWith(
      expect.objectContaining({ changedFiles: ['src/own.ts'] }),
    );
    expect(events.filter((event) => event.type === 'validate')).toEqual([]);
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

  it('runs the red a fix task answers again at end cadence, and a red fails the gate', async () => {
    const ref = setup();
    const task = makeTask({
      id: 'T004',
      fix: {
        cycle: 1,
        findings: [
          {
            id: 'P1',
            text: 'The test full-suite check before review failed.',
            acceptance: null,
            file: 'src/own.test.ts',
            stage: 'test',
            output: 'FAIL src/own.test.ts > adds',
          },
          {
            id: 'P2',
            text: 'Plan check K1 failed.',
            acceptance: null,
            checkIds: ['K1'],
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
    const validator = {
      ...createValidator(),
      formatChangedFiles: vi.fn().mockResolvedValue(undefined),
      runValidation: vi
        .fn()
        .mockResolvedValue([
          { stage: 'test', passed: false, error: 'FAIL src/own.test.ts > adds' },
        ]),
    };
    const result = await runBriefGate({
      wctx: makeWctx({
        ...ref,
        validator,
        config: makeNoValidationConfig({ validation: { test: true, lint: false } }),
      }),
      state: makeImplState([task], { plan }),
      task,
      changedFiles: ['src/own.ts'],
      taskStartSnapshot: null,
      runCommand,
    });
    expect(validator.runValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        stages: ['test'],
        changedFiles: ['src/own.ts', 'src/own.test.ts'],
        testMode: 'check',
      }),
    );
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(result.acceptance.accepted).toBe(false);
    expect(result.acceptance.blockingStages).toEqual(['test']);
    expect(result.error).toMatch(/FAIL src\/own\.test\.ts > adds/);
    expect(result.error).toMatch(/check K1 did not pass \(fail\)/);
  });

  it('hands its gate the run base the workspace recorded', async () => {
    const ref = setup();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/own.ts'] });
    const validator = { ...createValidator(), runValidation: vi.fn().mockResolvedValue([]) };
    await runBriefGate({
      wctx: makeWctx({
        ...ref,
        validator,
        config: makeNoValidationConfig({
          validation: { test: true },
          workflow: { review: 'task' },
        }),
      }),
      state: makeImplState([task], {
        workspace: {
          kind: 'worktree',
          path: '/state/trees/abc/sess-gate',
          base: { snapshotId: 'snap-base', head: 'abc123' },
        },
      }),
      task,
      changedFiles: ['src/own.ts'],
      taskStartSnapshot: null,
    });
    expect(validator.runValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        base: { projectDir: ref.projectDir, sessionId: ref.sessionId, snapshotId: 'snap-base' },
      }),
    );
  });
});
