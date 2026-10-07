import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { RetryOptions, ImplementerOptions } from '../../../src/engine/implementers/types.js';
import {
  REVIEW_FILE,
  REVIEW_JSON_FILE,
  reviewPacketJsonPath,
  sessionDir,
} from '../../../src/core/paths.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  runWorkspaceDir,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { seedValidationProject } from '#testing/helpers/validation-project.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import type { RunnerGate } from '../../../src/engine/runners/prepared-execution.js';
import {
  guidanceConsult,
  planFromTasks,
  typedCallFromTasks,
  typedCallPlanAndConsult,
} from '#testing/helpers/typed-planner.js';

const dirs: string[] = [];

beforeEach(() => {
  resetAllStores();
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function setupProject(expectedMarker = 'from-retry'): string {
  const projectDir = createTempDir('orch-int-full-loop-retry');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  seedValidationProject(projectDir, expectedMarker);
  return projectDir;
}

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

describe('full workflow validation retry loop', { timeout: 90_000 }, () => {
  it('retries after real validation fails, keeps the fix in the run workspace, and writes final review artifacts', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-full-loop-validation-retry';
    const targetFile = 'src/loop.ts';
    const badImplementation = 'export const loop = "from-initial";\n';
    const goodImplementation = 'export const loop = "from-retry";\n';
    const implementerProjectDirs: string[] = [];
    const retryProjectDirs: string[] = [];
    const retryErrors: string[] = [];
    const events: EngineEvent[] = [];

    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: [targetFile],
      title: 'Create retry-validated module',
      description: 'Create a module that satisfies the project validation script.',
      implementationSteps: ['Create src/loop.ts with the retry marker export.'],
      tests: ['node validate.mjs passes'],
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['validation fails once, retries, and passes before workflow_complete'],
      typeDefs: 'export const loop: string',
    });

    const planner = makePlanner({
      typedCall: typedCallFromTasks([task], { inputTokens: 140, outputTokens: 90 }),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nValidation passed after one local retry.\n\n### Verdict\npass',
        usage: { inputTokens: 60, outputTokens: 30 },
      }),
    });

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        implementerProjectDirs.push(opts.projectDir);
        expect(opts.projectDir).not.toBe(projectDir);
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, targetFile), badImplementation, 'utf-8');
        return {
          success: true,
          output: 'created initial implementation',
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      }),
      retry: vi.fn().mockImplementation(async (opts: RetryOptions) => {
        retryProjectDirs.push(opts.projectDir);
        retryErrors.push(opts.error);
        expect(opts.projectDir).not.toBe(projectDir);
        expect(readFileSync(join(opts.projectDir, targetFile), 'utf-8')).toBe(badImplementation);
        expect(existsSync(join(projectDir, targetFile))).toBe(false);
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, targetFile), goodImplementation, 'utf-8');
        return {
          success: true,
          output: 'fixed implementation',
          usage: { inputTokens: 35, outputTokens: 15 },
        };
      }),
    });

    const feature = 'run a validation retry loop';
    const config = makeConfig({
      implementer: {
        kind: 'agent',
        command: 'node',
        model: 'cheap-direct-agent',
        contextLength: 4096,
      },
      validation: {
        typecheck: false,
        lint: false,
        test: true,
        testCommand: 'node validate.mjs',
      },
      workflow: {
        approve: 'none',
        maxRetries: 1,
      },
    });
    const summary = await runWorkflow({
      prepared: makePreparedExecution({
        projectDir,
        sessionId,
        feature,
        config,
        gates: plannerCliGates,
      }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _implementer: implementer,
      _eventSink: (event) => events.push(event),
    });

    expect(implementerProjectDirs).toHaveLength(1);
    expect(retryProjectDirs).toHaveLength(1);
    expect(retryErrors[0]).toContain('Error type: test');
    expect(
      readFileSync(join(runWorkspaceDir({ projectDir, sessionId }), targetFile), 'utf-8'),
    ).toBe(goodImplementation);
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
      failed: 0,
    });

    const preReviewSuiteResults = events.filter(
      (event): event is Extract<EngineEvent, { type: 'full_suite' }> =>
        event.type === 'full_suite' && event.moment === 'pre-review' && event.status === 'done',
    );
    expect(preReviewSuiteResults.map((event) => event.passed)).toEqual([false, true]);

    const validationResults = events.filter(
      (event): event is Extract<EngineEvent, { type: 'validate' }> =>
        event.type === 'validate' && event.status === 'done',
    );
    expect(validationResults.map((event) => event.passed)).toEqual([true]);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'task_reset',
        'task_completed',
        'all_tasks_done',
        'workflow_complete',
      ]),
    );
    expect(readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE), 'utf-8')).toContain(
      '### Verdict\n\npass',
    );
    // The typed record is the verdict's home; the markdown above is its rendering.
    expect(
      JSON.parse(readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_JSON_FILE), 'utf-8')),
    ).toMatchObject({ outcome: 'pass', cycle: 1 });
    expect(existsSync(reviewPacketJsonPath({ projectDir, sessionId }))).toBe(true);
  }, 90_000);

  it('uses a planner consult when the local retry does not fix validation', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-full-loop-consult';
    const targetFile = 'src/loop.ts';
    const badImplementation = 'export const loop = "from-initial";\n';
    const consultImplementation = 'export const loop = "from-retry";\n';
    const retryKinds: string[] = [];
    const retryErrors: string[] = [];
    const events: EngineEvent[] = [];

    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: [targetFile],
      title: 'Create consult-validated module',
      description: 'Create a module that needs a planner consult before validation passes.',
      implementationSteps: ['Create src/loop.ts with the retry marker export.'],
      tests: ['node validate.mjs passes after the consult'],
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['the consult answer appears before workflow_complete'],
      typeDefs: 'export const loop: string',
    });

    const planner = makePlanner({
      typedCall: typedCallPlanAndConsult(
        () => planFromTasks([task]),
        () => guidanceConsult('Use the from-retry marker from validate.mjs.'),
        { inputTokens: 140, outputTokens: 90 },
      ),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nThe consult produced a passing implementation.\n\n### Verdict\npass',
        usage: { inputTokens: 60, outputTokens: 30 },
      }),
    });

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, targetFile), badImplementation, 'utf-8');
        return {
          success: true,
          output: 'created initial implementation',
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      }),
      retry: vi.fn().mockImplementation(async (opts: RetryOptions) => {
        retryKinds.push(opts.kind);
        retryErrors.push(opts.error);
        if (opts.kind === 'local') {
          return {
            success: false,
            output: '',
            error: 'local retry still misses the expected marker',
            usage: { inputTokens: 25, outputTokens: 10 },
          };
        }
        expect(opts.projectDir).not.toBe(projectDir);
        expect(opts.error).toContain('## Guidance from the planner:');
        expect(opts.error).toContain('Use the from-retry marker from validate.mjs.');
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, targetFile), consultImplementation, 'utf-8');
        return {
          success: true,
          output: 'fixed after the consult',
          usage: { inputTokens: 35, outputTokens: 15 },
        };
      }),
    });

    const feature = 'run a consult loop';
    const config = makeConfig({
      implementer: {
        kind: 'agent',
        command: 'node',
        model: 'cheap-direct-agent',
        contextLength: 4096,
      },
      validation: {
        typecheck: false,
        lint: false,
        test: true,
        testCommand: 'node validate.mjs',
      },
      workflow: {
        approve: 'none',
        maxRetries: 1,
      },
    });
    const summary = await runWorkflow({
      prepared: makePreparedExecution({
        projectDir,
        sessionId,
        feature,
        config,
        gates: plannerCliGates,
      }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _implementer: implementer,
      _eventSink: (event) => events.push(event),
    });

    expect(retryKinds).toEqual(['local', 'local', 'consult']);
    expect(retryErrors[0]).toContain('Error type: test');
    const taskRetries = events.filter(
      (event): event is Extract<EngineEvent, { type: 'task_retry' }> => event.type === 'task_retry',
    );
    expect(taskRetries).toHaveLength(1);
    expect(taskRetries[0]?.taskId).toBe('T001');
    const resetIndex = events.findIndex(
      (event) => event.type === 'task_reset' && event.taskId === 'T001',
    );
    const retryIndex = events.findIndex(
      (event) => event.type === 'task_retry' && event.taskId === 'T001',
    );
    expect(resetIndex).toBeGreaterThan(-1);
    expect(retryIndex).toBeGreaterThan(resetIndex);
    expect(
      readFileSync(join(runWorkspaceDir({ projectDir, sessionId }), targetFile), 'utf-8'),
    ).toBe(consultImplementation);
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
      failed: 0,
    });
    expect(events.find((event) => event.type === 'consult_answered')).toBeDefined();
    const taskCompletions = events.filter(
      (event): event is Extract<EngineEvent, { type: 'task_completed' }> =>
        event.type === 'task_completed' && event.taskId === 'T001',
    );
    expect(taskCompletions.map((event) => event.method)).toEqual(['local', 'consulted']);
    expect(events.map((event) => event.type)).toContain('workflow_complete');
    expect(readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE), 'utf-8')).toContain(
      '### Verdict\n\npass',
    );
  }, 90_000);
});
