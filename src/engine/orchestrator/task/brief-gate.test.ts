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

  it('rechecks only the stages and checks carried by a reopened brief', async () => {
    const ref = setup();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/own.ts'] });
    const validator = { ...createValidator(), runValidation: vi.fn().mockResolvedValue([]) };
    const state = makeImplState([task], {
      lineages: {
        T001: {
          consults: 0,
          attempts: 0,
          consultAllowance: 2,
          attemptAllowance: 8,
          staleConsultedRevision: {},
          consultRecords: [],
          replacedParents: [],
          notes: [],
          gateFailure: { stages: ['typecheck'], files: ['src/prior.ts'], checkIds: [] },
        },
      },
    });
    const result = await runBriefGate({
      wctx: makeWctx({
        ...ref,
        validator,
        config: makeNoValidationConfig({ validation: { typecheck: true } }),
      }),
      state,
      task,
      changedFiles: ['src/own.ts'],
      taskStartSnapshot: null,
    });
    expect(result.acceptance.accepted).toBe(true);
    expect(validator.runValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        stages: ['typecheck'],
        changedFiles: ['src/own.ts', 'src/prior.ts'],
      }),
    );
  });

  it('runs a carried test red unnarrowed when the test command cannot select related tests', async () => {
    const ref = setup();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/own.ts'] });
    const runCommand = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 });
    const state = makeImplState([task], {
      lineages: {
        T001: {
          consults: 0,
          attempts: 0,
          consultAllowance: 2,
          attemptAllowance: 8,
          staleConsultedRevision: {},
          consultRecords: [],
          replacedParents: [],
          notes: [],
          gateFailure: { stages: ['test'], files: ['src/own.test.ts'], checkIds: [] },
        },
      },
    });
    const result = await runBriefGate({
      wctx: makeWctx({
        ...ref,
        validator: createValidator({ runCommand }),
        config: makeNoValidationConfig({
          validation: { test: true, testCommand: 'node run-tests.mjs' },
        }),
      }),
      state,
      task,
      changedFiles: ['src/own.ts'],
      taskStartSnapshot: null,
    });
    expect(result.validationResults).toMatchObject([{ stage: 'test', passed: true }]);
    expect(result.validationResults[0]?.skipped).toBeUndefined();
    expect(runCommand).toHaveBeenCalledWith('node', ['run-tests.mjs'], expect.anything());
  });
});
