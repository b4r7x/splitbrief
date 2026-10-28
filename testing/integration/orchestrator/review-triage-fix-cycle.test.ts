import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import { REVIEW_FILE, REVIEW_JSON_FILE, sessionDir } from '../../../src/core/paths.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  runWorkspaceDir,
} from '#testing/helpers/orchestrator-factories.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import type { RunnerGate } from '../../../src/engine/runners/prepared-execution.js';
import type { TypedCallContext } from '../../../src/engine/planners/types.js';
import type { TypedSeatCall } from '../../../src/engine/runners/typed-output.js';
import type { ReviewAnswer } from '../../../src/core/schemas/review.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import {
  failedReviewVerdict,
  passingReviewVerdict,
  planFromTasks,
} from '#testing/helpers/typed-planner.js';

const dirs: string[] = [];

beforeEach(() => {
  resetAllStores();
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function plannerCliGates(preparationId: string): ReadonlyArray<RunnerGate> {
  return [
    {
      kind: 'cli',
      slot: { role: 'planner' },
      preparationId,
      tool: 'claude-code',
      executable: executableReceipt(),
    },
    {
      kind: 'agent',
      slot: { role: 'implementer', profile: 'default' },
      preparationId,
      command: { kind: 'validated-config' },
    },
  ];
}

const BASE_WIDGET = "export const render = () => 'widget';\n";
const FIXED_WIDGET = [
  'export const render = () => {',
  '  try {',
  "    return 'widget';",
  '  } catch (err) {',
  '    throw err;',
  '  }',
  '};',
].join('\n');

/** A seat whose every typed call answers from `answer`, recording each prompt it was sent. */
function scriptedSeat(answer: (prompt: string, call: number) => unknown) {
  const prompts: string[] = [];
  const typedCall = vi.fn(
    (ctx: TypedCallContext): TypedSeatCall => ({
      seat: ctx.seat,
      typedOutput: 'fallback',
      canResume: false,
      invoke: async ({ prompt }) => {
        prompts.push(prompt);
        return makeRunnerCallResult({
          status: 'completed',
          text: JSON.stringify(answer(prompt, prompts.length)),
          usage: { inputTokens: 10, outputTokens: 5 },
        });
      },
    }),
  );
  return { typedCall, prompts };
}

describe('review fix cycle', { timeout: 90_000 }, () => {
  it("the reviewer's own answer appends the fix task, the implementer runs it, and the next review passes; the planner only plans", async () => {
    const projectDir = createTempDir('orch-int-review-triage');
    dirs.push(projectDir);
    createTestGitRepo(projectDir, { 'src/shared/widget.ts': BASE_WIDGET });
    const sessionId = 'sess-review-triage-fix';
    const events: EngineEvent[] = [];

    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: ['src/alpha.ts'],
      title: 'Create the greeting module',
      description: 'Create the greeting module the plan asks for.',
      implementationSteps: ['Create src/alpha.ts with the greeting export.'],
      tests: ['src/alpha.ts exports the greeting'],
      scope: { inBounds: ['src/alpha.ts'], outOfBounds: ['src/shared/widget.ts'] },
      evidence: ['the greeting export exists before workflow_complete'],
      typeDefs: 'export const greeting: string',
    });

    const plannerSeat = scriptedSeat((_prompt, call) => {
      if (call > 1) throw new Error('the planner was asked a second time after planning');
      return { result: planFromTasks([task]) };
    });
    const planner = makePlanner({ typedCall: plannerSeat.typedCall });
    const reviewerSeat = scriptedSeat((prompt, call): ReviewAnswer => {
      const noFixWork = { fixTasks: [], rejected: [], verify: [], ask: null };
      if (call > 1) return { ...passingReviewVerdict(prompt), ...noFixWork };
      return {
        ...failedReviewVerdict(prompt, 'src/shared/widget.ts drops the error', {
          taskId: 'T001',
          file: 'src/shared/widget.ts',
        }),
        ...noFixWork,
        fixTasks: [
          {
            ...makeTaskSpec({
              id: 'T002',
              suggestedFiles: ['src/shared/widget.ts'],
              checks: [{ id: 'K2', kind: 'cmd', value: 'node --version', required: true }],
            }),
            findingIds: ['F1'],
          },
        ],
      };
    });

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        expect(opts.projectDir).not.toBe(projectDir);
        const file = opts.task.suggestedFiles[0];
        mkdirSync(join(opts.projectDir, dirname(file)), { recursive: true });
        writeFileSync(
          join(opts.projectDir, file),
          file === 'src/shared/widget.ts' ? FIXED_WIDGET : "export const greeting = 'hello';\n",
          'utf-8',
        );
        return { success: true, output: 'written', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
      retry: vi.fn(),
    });

    const config = makeNoValidationConfig({
      reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5' },
      implementer: {
        kind: 'agent',
        command: 'node',
        model: 'cheap-direct-agent',
        contextLength: 4096,
      },
      workflow: { approve: 'none' },
    });
    const summary = await runWorkflow({
      prepared: makePreparedExecution({
        projectDir,
        sessionId,
        feature: 'review triage fix cycle',
        config,
        gates: plannerCliGates,
      }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _reviewer: { review: vi.fn(), typedCall: reviewerSeat.typedCall },
      _implementer: implementer,
      _eventSink: (event) => events.push(event),
    });

    // No user decision was needed: the review appended the work and the run finished.
    // The planner planned once; the reviewer was called once per review and wrote the fix task.
    expect(plannerSeat.prompts).toHaveLength(1);
    expect(reviewerSeat.prompts).toHaveLength(2);
    expect(reviewerSeat.typedCall.mock.calls.every(([ctx]) => ctx.seat === 'reviewer')).toBe(true);
    expect(vi.mocked(implementer.implement).mock.calls.map((call) => call[0].task.id)).toEqual([
      'T001',
      'T002',
    ]);
    expect(implementer.retry).not.toHaveBeenCalled();
    expect(
      readFileSync(
        join(runWorkspaceDir({ projectDir, sessionId }), 'src/shared/widget.ts'),
        'utf-8',
      ),
    ).toBe(FIXED_WIDGET);

    const state = loadState({ projectDir, sessionId });
    expect(state?.tasks.map((task) => task.id)).toEqual(['T001', 'T002']);
    expect(state?.tasks[0]).toMatchObject({ status: 'done' });
    expect(state?.tasks[1]).toMatchObject({
      status: 'done',
      batch: 2,
      fix: {
        cycle: 1,
        findings: [
          {
            id: 'F1',
            text: 'src/shared/widget.ts drops the error',
            acceptance: null,
          },
        ],
      },
    });
    expect(state?.fixCycles).toEqual({ used: 1, notes: [] });
    expect(state?.triage?.map((record) => record.result.fixTasks.map((fix) => fix.id))).toEqual([
      ['T002'],
    ]);
    expect(state?.reviewStatus).toBe('passed');

    expect(events.find((event) => event.type === 'review_fix_started')).toMatchObject({
      cycle: 1,
      taskIds: ['T002'],
    });
    expect(events.find((event) => event.type === 'workflow_complete')).toMatchObject({
      review: 'passed',
    });
    // A completed brief was never reopened: no reset, no lineage change.
    expect(events.some((event) => event.type === 'task_reset')).toBe(false);
    expect(summary).toMatchObject({ totalTasks: 2, completedByLocal: 2, failed: 0 });

    expect(
      JSON.parse(readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_JSON_FILE), 'utf-8')),
    ).toMatchObject({
      outcome: 'pass',
      cycle: 1,
    });
    expect(readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE), 'utf-8')).toContain(
      '### Verdict\n\npass',
    );
  });
});
