import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { RetryOptions, ImplementerOptions } from '../../../src/engine/implementers/types.js';
import { REVIEW_FILE, reviewPacketJsonPath, sessionDir } from '../../../src/core/paths.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
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
  it('retries after real validation fails, promotes the staged fix, and writes final review artifacts', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-full-loop-validation-retry';
    const targetFile = 'src/loop.ts';
    const badImplementation = 'export const loop = "from-initial";\n';
    const goodImplementation = 'export const loop = "from-retry";\n';
    const implementerProjectDirs: string[] = [];
    const retryProjectDirs: string[] = [];
    const events: EngineEvent[] = [];

    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: targetFile,
      title: 'Create retry-validated module',
      description: 'Create a module that satisfies the project validation script.',
      implementationSteps: ['Create src/loop.ts with the retry marker export.'],
      tests: ['node validate.mjs passes'],
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['validation fails once, retries, and passes before workflow_complete'],
      typeDefs: 'export const loop: string',
    });

    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec\n\nCreate a retry-validated module.',
        plan: '# Plan\n\nCreate the module and pass validation.',
        tasks: [task],
        usage: { inputTokens: 140, outputTokens: 90 },
      }),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nValidation passed after one local retry.',
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
        expect(opts.projectDir).not.toBe(projectDir);
        expect(readFileSync(join(projectDir, targetFile), 'utf-8')).toBe(badImplementation);
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
        mode: 'standard',
        approve: 'none',
        maxRetries: 1,
        persistTranscript: true,
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
    expect(readFileSync(join(projectDir, targetFile), 'utf-8')).toBe(goodImplementation);
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
      failed: 0,
    });

    const validationResults = events.filter(
      (event): event is Extract<EngineEvent, { type: 'validate' }> =>
        event.type === 'validate' && event.status === 'done',
    );
    expect(validationResults.map((event) => event.passed)).toEqual([false, true]);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'task_retry',
        'task_completed',
        'all_tasks_done',
        'workflow_complete',
      ]),
    );
    expect(readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE), 'utf-8')).toContain(
      'Validation passed after one local retry.',
    );
    expect(existsSync(reviewPacketJsonPath(projectDir, sessionId))).toBe(true);
  }, 90_000);

  it('uses planner hint escalation when local retry does not fix validation', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-full-loop-hint-escalation';
    const targetFile = 'src/loop.ts';
    const badImplementation = 'export const loop = "from-initial";\n';
    const hintImplementation = 'export const loop = "from-retry";\n';
    const retryKinds: string[] = [];
    const events: EngineEvent[] = [];

    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: targetFile,
      title: 'Create hint-validated module',
      description: 'Create a module that needs planner hint escalation before validation passes.',
      implementationSteps: ['Create src/loop.ts with the retry marker export.'],
      tests: ['node validate.mjs passes after hint escalation'],
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['tier-1 escalation event appears before workflow_complete'],
      typeDefs: 'export const loop: string',
    });

    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec\n\nCreate a module with hint escalation.',
        plan: '# Plan\n\nCreate the module and fix it with a hint when needed.',
        tasks: [task],
        usage: { inputTokens: 140, outputTokens: 90 },
      }),
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'Use the from-retry marker expected by validate.mjs.',
        code: null,
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nHint escalation produced a passing implementation.',
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
        if (opts.kind === 'local') {
          return {
            success: false,
            output: '',
            error: 'local retry still misses the expected marker',
            usage: { inputTokens: 25, outputTokens: 10 },
          };
        }
        expect(opts.projectDir).not.toBe(projectDir);
        expect(opts.error).toContain('Hints from senior reviewer');
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, targetFile), hintImplementation, 'utf-8');
        return {
          success: true,
          output: 'fixed after hint',
          usage: { inputTokens: 35, outputTokens: 15 },
        };
      }),
    });

    const feature = 'run a hint escalation loop';
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
        mode: 'standard',
        approve: 'none',
        maxRetries: 1,
        persistTranscript: true,
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

    expect(retryKinds).toEqual(['local', 'hint']);
    expect(readFileSync(join(projectDir, targetFile), 'utf-8')).toBe(hintImplementation);
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 0,
      escalatedToPlanner: 1,
      failed: 0,
    });
    expect(events.find((event) => event.type === 'escalate' && event.tier === 1)).toBeDefined();
    expect(events.find((event) => event.type === 'task_completed')).toMatchObject({
      method: 'escalated-hint',
    });
    expect(events.map((event) => event.type)).toContain('workflow_complete');
    expect(readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE), 'utf-8')).toContain(
      'Hint escalation produced a passing implementation.',
    );
  }, 90_000);
});
