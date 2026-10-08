import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { makeBusRecorder, makePlanner, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { saveState } from '../../../core/state/persistence.js';
import type { TypedCallContext } from '../../planners/types.js';
import type { TypedSeatCall } from '../../runners/typed-output.js';
import { createValidator } from '../validation/run.js';
import type { RunFullSuiteResult, Validator } from '../validation/types.js';
import { runPreReview } from './pre-review-checks.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function doneTask(id: string, file: string): Task {
  return makeTask({ id, suggestedFiles: [file], status: 'done' });
}

function ledgerFor(tasks: Task[], changed: Record<string, string[]>): EvidenceLedger {
  const ledger = createEvidenceLedger({ sessionId: 'sess-routing', feature: 'feat', tasks });
  return {
    ...ledger,
    tasks: ledger.tasks.map((entry) => ({ ...entry, changedFiles: changed[entry.id] ?? [] })),
  };
}

function typecheckSuite(errorLines: string[]): RunFullSuiteResult {
  const keys = errorLines.map((line) => line.slice(0, line.indexOf(':')));
  return {
    results: [
      {
        passed: false,
        stage: 'typecheck',
        command: 'npx tsc --noEmit',
        error: errorLines.join('\n'),
        output: errorLines.join('\n'),
      },
    ],
    newFailures: { typecheck: keys },
  };
}

function scriptedPlanner(script: string[]) {
  const prompts: string[] = [];
  const typedCall = vi.fn(
    (ctx: TypedCallContext): TypedSeatCall => ({
      seat: ctx.seat,
      typedOutput: 'fallback',
      canResume: false,
      invoke: async ({ prompt }) => {
        prompts.push(prompt);
        const next = script.shift();
        if (next === undefined) throw new Error('the planner was asked once too often');
        return makeRunnerCallResult({
          status: 'completed',
          text: next,
          usage: { inputTokens: 10, outputTokens: 5 },
        });
      },
    }),
  );
  return { planner: makePlanner({ typedCall }), prompts, typedCall };
}

function setup(state: WorkflowState, changed: Record<string, string[]>) {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'pre-review-routing',
    sessionId: 'sess-routing',
  });
  dirs.push(projectDir);
  saveState({ projectDir, sessionId }, state);
  writeEvidenceLedger({ projectDir, sessionId }, ledgerFor(state.tasks, changed));
  return { projectDir, sessionId };
}

describe('runPreReview hands a red gate to the review', () => {
  it('reopens no brief and calls no planner: a red that names one brief queues as a pending input for the reviewer', async () => {
    const tasks = [doneTask('T001', 'src/first.ts'), doneTask('T002', 'src/second.ts')];
    const state = makeImplState(tasks, {
      phase: 'final-review',
      fixCycles: { used: 0, allowance: 2, notes: [] },
    });
    const { projectDir, sessionId } = setup(state, {
      T001: ['src/first.ts'],
      T002: ['src/second.ts'],
    });
    const planner = scriptedPlanner([]);
    const { bus, events } = makeBusRecorder();
    const validator: Validator = {
      ...createValidator(),
      runFullSuite: async () =>
        typecheckSuite(["src/second.ts(5,1): error TS2322: Type 'string' is not 'number'."]),
    };

    const result = await runPreReview({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ validation: { typecheck: true }, workflow: {} }),
        planner: planner.planner,
        validator,
        bus,
      }),
      state,
      setTrackedState: vi.fn(),
    });

    expect(result.kind).toBe('review');
    expect(planner.typedCall).not.toHaveBeenCalled();
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
    expect(result.state.phase).toBe('final-review');
    expect(result.state.fixCycles?.used).toBe(0);
    expect(result.state.lineages?.['T002']?.carriedFailure).toBeUndefined();
    expect(events.some((event) => event.type === 'task_reset')).toBe(false);
    expect(result.state.pendingTriage?.inputs).toEqual([
      expect.objectContaining({ id: 'P1', source: 'check', file: 'src/second.ts' }),
    ]);
    expect(result.state.pendingTriage?.inputs[0]?.text).toContain('Last changed by T002.');
  });

  it('queues a red that names files of two briefs as one pending input per file, still with no planner call', async () => {
    const tasks = [doneTask('T001', 'src/first.ts'), doneTask('T002', 'src/second.ts')];
    const state = makeImplState(tasks, {
      phase: 'final-review',
      fixCycles: { used: 0, allowance: 2, notes: [] },
    });
    const { projectDir, sessionId } = setup(state, {
      T001: ['src/first.ts'],
      T002: ['src/second.ts'],
    });
    const planner = scriptedPlanner([]);
    const validator: Validator = {
      ...createValidator(),
      runFullSuite: async () =>
        typecheckSuite([
          "src/first.ts(2,1): error TS2322: Type 'string' is not 'number'.",
          "src/second.ts(5,1): error TS2322: Type 'string' is not 'number'.",
        ]),
    };

    const result = await runPreReview({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ validation: { typecheck: true }, workflow: {} }),
        planner: planner.planner,
        validator,
        bus: makeBusRecorder().bus,
      }),
      state,
      setTrackedState: vi.fn(),
    });

    expect(result.kind).toBe('review');
    expect(planner.typedCall).not.toHaveBeenCalled();
    expect(result.state.tasks.map((task) => task.id)).toEqual(['T001', 'T002']);
    expect(result.state.pendingTriage?.inputs.map((input) => [input.id, input.file])).toEqual([
      ['P1', 'src/first.ts'],
      ['P2', 'src/second.ts'],
    ]);
  });
});
