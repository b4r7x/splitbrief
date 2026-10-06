import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import { REVIEW_FILE, sessionDir } from '../../../src/core/paths.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePricedModelCache } from '#testing/helpers/factories/model-cache.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { tokensStore } from '../../../src/stores/workflow/tokens.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { seedValidationProject } from '#testing/helpers/validation-project.js';
import {
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import { ensureConfigGitignore } from '../../../src/core/config/load/document.js';

const dirs: string[] = [];

beforeEach(() => {
  resetAllStores();
});

afterEach(() => {
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

const REVIEW_TEXT = '# Final review\n\nThe planner reviewed the run diff.\n\n### Verdict\npass\n';
const REVIEW_USAGE = { inputTokens: 60, outputTokens: 30 };
const PLAN_USAGE = { inputTokens: 140, outputTokens: 90 };
const PLANNER_PROVIDER = 'planner-endpoint';
const PLANNER_MODEL = 'claude-sonnet-5';
const IMPLEMENTED_MARKER = 'from-implementer';

// A custom endpoint has no runtime rate rows; it prices through the catalog on
// its model id, so the seat needs a model the priced catalog knows.
const modelCache = makePricedModelCache();

describe('run with no reviewer configured', () => {
  it('keeps the planner in the review seat, and its artifact, events and cost lines', async () => {
    const projectDir = createTempDir('orch-int-unconfigured-reviewer');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    ensureConfigGitignore(projectDir);
    seedValidationProject(projectDir, IMPLEMENTED_MARKER);
    const sessionId = 'sess-unconfigured-reviewer';
    const targetFile = 'src/loop.ts';
    const events: EngineEvent[] = [];

    let reviewCalls = 0;
    const planner = makePlanner({
      typedCall: typedCallPlanAndReview(
        () =>
          planFromTasks([
            makeTask({
              id: 'T001',
              action: 'create',
              suggestedFiles: [targetFile],
              title: 'Create validated module',
              description: 'Create a module that satisfies the project validation script.',
              implementationSteps: ['Create src/loop.ts with the marker export.'],
              tests: ['node validate.mjs passes'],
              scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
              evidence: ['validation passes before workflow_complete'],
              typeDefs: 'export const loop: string',
            }),
          ]),
        (prompt, _call, callbacks) => {
          reviewCalls += 1;
          callbacks.onOutput(REVIEW_TEXT);
          return passingReviewVerdict(prompt);
        },
        { plan: PLAN_USAGE, review: REVIEW_USAGE },
      ),
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
        apiBase: 'https://api.planner.test/v1',
      },
      implementer: {
        kind: 'agent',
        command: 'node',
        model: 'cheap-direct-agent',
        contextLength: 4096,
      },
      validation: { typecheck: false, lint: false, test: true, testCommand: 'node validate.mjs' },
      workflow: { approve: 'none', maxRetries: 1 },
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
          endpointOrigin: 'https://api.planner.test',
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

    expect(reviewCalls).toBe(1);
    expect(readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE), 'utf-8')).toContain(
      '### Verdict\n\npass',
    );

    // Seat resolution happens at init, so a new event there would show here too.
    const types = events.map((event) => event.type);
    expect(types).toEqual([
      'workflow_started',
      'planner_status',
      'user_message',
      'workflow_config',
      // One planning session: it starts, it books its tokens, and plan.md and tasks.md, rendered
      // from the plan, are on disk before the build begins.
      'planner_status',
      'cost_update',
      'artifact_written',
      'artifact_written',
      'snapshot_created',
      'snapshot_created',
      'tasks_planned',
      'validation_baseline',
      'validation_baseline',
      'validation_baseline',
      'validation_baseline',
      'full_suite',
      'full_suite',
      'task_started',
      'cost_update',
      'validate',
      'validate',
      'validate',
      'validate',
      'checks_run',
      'task_completed',
      'task_tokens',
      'full_suite',
      'full_suite',
      'snapshot_created',
      'full_suite',
      'full_suite',
      'planner_status',
      'all_tasks_done',
      'drift_report',
      'planner_text',
      'cost_update',
      'planner_status',
      'workflow_complete',
    ]);

    const plannerTexts = events.filter(
      (event): event is Extract<EngineEvent, { type: 'planner_text' }> =>
        event.type === 'planner_text',
    );
    expect(plannerTexts).toHaveLength(1);
    expect(plannerTexts[0]?.text).toContain(REVIEW_TEXT);

    // Seat resolution happens at init, so a reviewer seat would surface here.
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

    // A run without a reviewer bills the review tokens on the strong side's single cost line.
    // Each planner call books its own usage, so the planning half is one charge per call.
    const planningCalls = vi.mocked(planner.typedCall).mock.calls.length - reviewCalls;
    const providerCosts = summary.costBreakdown?.providerCosts ?? {};
    expect(Object.keys(providerCosts)).toEqual([PLANNER_PROVIDER]);
    expect(providerCosts[PLANNER_PROVIDER]).toMatchObject({
      inputTokens: PLAN_USAGE.inputTokens * planningCalls + REVIEW_USAGE.inputTokens,
      outputTokens: PLAN_USAGE.outputTokens * planningCalls + REVIEW_USAGE.outputTokens,
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
