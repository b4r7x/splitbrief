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
import {
  failedReviewVerdict,
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanReviewAndTriage,
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

describe('review triage fix cycle', { timeout: 90_000 }, () => {
  it('a failing review appends a fix task for an unsuggested file and the next review passes', async () => {
    const projectDir = createTempDir('orch-int-review-triage');
    dirs.push(projectDir);
    createTestGitRepo(projectDir, { 'src/shared/widget.ts': BASE_WIDGET });
    const sessionId = 'sess-review-triage-fix';
    const events: EngineEvent[] = [];

    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/alpha.ts',
      title: 'Create the greeting module',
      description: 'Create the greeting module the plan asks for.',
      implementationSteps: ['Create src/alpha.ts with the greeting export.'],
      tests: ['src/alpha.ts exports the greeting'],
      scope: { inBounds: ['src/alpha.ts'], outOfBounds: ['src/shared/widget.ts'] },
      evidence: ['the greeting export exists before workflow_complete'],
      typeDefs: 'export const greeting: string',
    });

    let reviews = 0;
    const triagePrompts: string[] = [];
    const planner = makePlanner({
      typedCall: typedCallPlanReviewAndTriage(
        () => planFromTasks([task]),
        (prompt) => {
          reviews += 1;
          return reviews === 1
            ? failedReviewVerdict(prompt, 'src/shared/widget.ts drops the error', {
                taskId: 'T001',
                file: 'src/shared/widget.ts',
              })
            : passingReviewVerdict(prompt);
        },
        (prompt) => {
          triagePrompts.push(prompt);
          return {
            fixTasks: [
              {
                ...makeTaskSpec({ id: 'T002', suggestedFiles: ['src/shared/widget.ts'] }),
                findingIds: ['F1'],
              },
            ],
            rejected: [],
            verify: [],
            ask: null,
          };
        },
      ),
    });

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        expect(opts.projectDir).not.toBe(projectDir);
        const file = opts.task.file;
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
      implementer: {
        kind: 'agent',
        command: 'node',
        model: 'cheap-direct-agent',
        contextLength: 4096,
      },
      workflow: { approve: 'none', maxRetries: 1 },
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
      _implementer: implementer,
      _eventSink: (event) => events.push(event),
    });

    // No user decision was needed: the triage appended the work and the run finished.
    expect(reviews).toBe(2);
    expect(triagePrompts).toHaveLength(1);
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
    expect(state?.fixCycles).toEqual({ used: 1, allowance: 2, notes: [] });
    expect(state?.plannerCalls?.used).toBe(1);
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
