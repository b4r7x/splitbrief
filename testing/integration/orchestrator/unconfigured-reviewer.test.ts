import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import type { PlannerOutputCallbacks } from '../../../src/engine/planners/types.js';
import { REVIEW_FILE, sessionDir } from '../../../src/core/paths.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { tokensStore } from '../../../src/stores/workflow/tokens.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { seedValidationProject } from '#testing/helpers/validation-project.js';

const dirs: string[] = [];

beforeEach(() => {
  resetAllStores();
});

afterEach(() => {
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

const REVIEW_TEXT = '# Final review\n\nThe planner reviewed the run diff.';
const REVIEW_USAGE = { inputTokens: 60, outputTokens: 30 };
const PLAN_USAGE = { inputTokens: 140, outputTokens: 90 };
const PLANNER_PROVIDER = 'openai';
const PLANNER_MODEL = 'priced-planner-model';
const IMPLEMENTED_MARKER = 'from-implementer';

const modelCache = makeModelCacheAccessor({
  providerModels: {
    [PLANNER_PROVIDER]: [{ id: PLANNER_MODEL, pricingInput: 1, pricingOutput: 2 }],
  },
});

describe('run with no reviewer configured', () => {
  it('keeps the planner in the review seat, and its artifact, events and cost lines', async () => {
    const projectDir = createTempDir('orch-int-unconfigured-reviewer');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    seedValidationProject(projectDir, IMPLEMENTED_MARKER);
    const sessionId = 'sess-unconfigured-reviewer';
    const targetFile = 'src/loop.ts';
    const events: EngineEvent[] = [];

    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec\n\nCreate a validated module.',
        plan: '# Plan\n\nCreate the module and pass validation.',
        tasks: [
          makeTask({
            id: 'T001',
            action: 'create',
            file: targetFile,
            title: 'Create validated module',
            description: 'Create a module that satisfies the project validation script.',
            implementationSteps: ['Create src/loop.ts with the marker export.'],
            tests: ['node validate.mjs passes'],
            scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
            evidence: ['validation passes before workflow_complete'],
            typeDefs: 'export const loop: string',
          }),
        ],
        usage: PLAN_USAGE,
      }),
      review: vi
        .fn()
        .mockImplementation(async (_prompt: string, _dir: string, cb: PlannerOutputCallbacks) => {
          cb.onOutput(REVIEW_TEXT);
          return { text: REVIEW_TEXT, usage: REVIEW_USAGE };
        }),
    });

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(
          join(opts.projectDir, targetFile),
          `export const loop = "${IMPLEMENTED_MARKER}";\n`,
        );
        return { success: true, output: 'created', usage: { inputTokens: 50, outputTokens: 20 } };
      }),
    });

    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: PLANNER_PROVIDER,
        model: PLANNER_MODEL,
        apiBase: 'https://api.openai.test/v1',
      },
      implementer: {
        kind: 'agent',
        command: 'node',
        model: 'cheap-direct-agent',
        contextLength: 4096,
      },
      validation: { typecheck: false, lint: false, test: true, testCommand: 'node validate.mjs' },
      workflow: { mode: 'standard', approve: 'none', maxRetries: 1, persistTranscript: true },
    });
    const prepared = makePreparedExecution({
      projectDir,
      sessionId,
      feature: 'review with no reviewer configured',
      config,
      // Two gates, no `{ role: 'reviewer' }` one: a run that built a reviewer
      // runner of its own would be refused admission here.
      gates: (preparationId) => [
        {
          kind: 'api',
          slot: { role: 'planner' },
          preparationId,
          provider: PLANNER_PROVIDER,
          endpointOrigin: 'https://api.openai.test',
        },
        {
          kind: 'agent',
          slot: { role: 'implementer', profile: 'default' },
          preparationId,
          command: { kind: 'validated-config' },
        },
      ],
    });

    const summary = await runWorkflow({
      prepared,
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _implementer: implementer,
      modelCache,
      _eventSink: (event) => {
        events.push(event);
        addEvent(event);
      },
    });

    expect(planner.review).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE), 'utf-8')).toContain(
      REVIEW_TEXT,
    );

    // The whole sequence as it was before the review seat became assignable:
    // seat resolution happens at init, so a new event there would show here too.
    const types = events.map((event) => event.type);
    expect(types).toEqual([
      'workflow_started',
      'planner_status',
      'user_message',
      'workflow_config',
      'mode_resolved',
      'cost_update',
      'planner_status',
      'planner_status',
      'planner_status',
      'planner_status',
      'brief_quality_passed',
      'brief_readiness_passed',
      'brief_execution_permit_issued',
      'artifact_written',
      'cost_prediction',
      'warning',
      'tasks_planned',
      'validation_baseline',
      'validation_baseline',
      'validation_baseline',
      'validation_baseline',
      'task_started',
      'cost_update',
      'validate',
      'validate',
      'validate',
      'validate',
      'task_completed',
      'task_tokens',
      'planner_status',
      'all_tasks_done',
      'drift_report',
      'planner_text',
      'cost_update',
      'planner_status',
      'workflow_complete',
    ]);

    const workflowConfig = events.find(
      (event): event is Extract<EngineEvent, { type: 'workflow_config' }> =>
        event.type === 'workflow_config',
    );
    expect(workflowConfig?.reviewerTool).toBeUndefined();
    expect(workflowConfig?.reviewerModel).toBeUndefined();

    expect(summary.reviewerTool).toBeUndefined();
    expect(summary.reviewerModel).toBeUndefined();
    expect(summary.tokenUsage.reviewerInput).toBe(REVIEW_USAGE.inputTokens);
    expect(summary.tokenUsage.reviewerOutput).toBe(REVIEW_USAGE.outputTokens);

    // One cost line for the strong side, carrying the review tokens: that is
    // the pre-change accounting, and the only line a run without a reviewer had.
    const providerCosts = summary.costBreakdown?.providerCosts ?? {};
    expect(Object.keys(providerCosts)).toEqual([PLANNER_PROVIDER]);
    expect(providerCosts[PLANNER_PROVIDER]).toMatchObject({
      inputTokens: PLAN_USAGE.inputTokens + REVIEW_USAGE.inputTokens,
      outputTokens: PLAN_USAGE.outputTokens + REVIEW_USAGE.outputTokens,
    });
    expect(summary.costBreakdown?.actualReviewerCost).toBeUndefined();

    // The per-phase drilldown still bills the final review: moving the tokens
    // into the reviewer bucket must not zero the phase the planner carried.
    expect(tokensStore.get().perPhase['final-review']).toMatchObject({
      inputTokens: REVIEW_USAGE.inputTokens,
      outputTokens: REVIEW_USAGE.outputTokens,
    });
  }, 90_000);
});
