import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
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
import type { Config } from '../../../src/core/schemas/config.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../../src/engine/runners/prepared-execution.js';

const dirs: string[] = [];

beforeEach(() => {
  resetAllStores();
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function setupProject(): string {
  const projectDir = createTempDir('orch-int-baseline-acceptance');
  dirs.push(projectDir);
  createTestGitRepo(projectDir, { 'src/loop.ts': 'export const loop = "initial";\n' });
  seedValidationProject(projectDir, 'from-retry');
  return projectDir;
}

function preparedExecution(input: {
  projectDir: string;
  sessionId: string;
  feature: string;
  config: Config;
}): PreparedExecution {
  const config = parsePreparedConfig(input.config);
  const preparationId = `${input.sessionId}-preparation`;
  const active = {
    version: 1 as const,
    sessionId: input.sessionId,
    generation: '7a777777-7777-4777-8777-777777777777',
  };
  return {
    purpose: 'new-workflow',
    config,
    preparationId,
    report: {
      generatedAt: '2026-08-04T00:00:00.000Z',
      projectDir: input.projectDir,
      status: 'ready',
      counts: { ok: 2, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
      sections: [],
      metadata: {},
    },
    gates: [
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
    ],
    session: {
      kind: 'existing',
      ref: { projectDir: input.projectDir, sessionId: input.sessionId },
      active,
    },
    runtime: {
      feature: input.feature,
      allowRepoRunners: false,
      allowHooks: false,
    },
  };
}

describe('baseline-relative acceptance', { timeout: 90_000 }, () => {
  it('completes a task over a tree red before and after, with no retry and no escalation', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-baseline-relative-acceptance';
    const targetFile = 'src/other.ts';
    const redFile = 'src/loop.ts';
    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: targetFile,
      title: 'Create a module that leaves the broken file alone',
      description:
        'Create a module in a project whose configured validation command is red before the run.',
      implementationSteps: ['Create src/other.ts with the module export.'],
      tests: ['node validate.mjs still fails for the pre-existing reason'],
      scope: { inBounds: [targetFile], outOfBounds: [redFile] },
      evidence: ['the task completes even though validation is red before and after'],
      typeDefs: 'export const other: string',
    });

    const before = spawnSync('node', ['validate.mjs'], { cwd: projectDir, encoding: 'utf-8' });
    expect(before.status).not.toBe(0);

    const events: EngineEvent[] = [];
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec\n\nCreate a module in a red-baseline project.',
        plan: '# Plan\n\nCreate the module.',
        tasks: [task],
        usage: { inputTokens: 140, outputTokens: 90 },
      }),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nTask completed over a pre-existing red validation stage.',
        usage: { inputTokens: 60, outputTokens: 30 },
      }),
    });
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        expect(opts.projectDir).not.toBe(projectDir);
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(
          join(opts.projectDir, targetFile),
          'export const other = "unrelated";\n',
          'utf-8',
        );
        return {
          success: true,
          output: 'created unrelated module',
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      }),
    });

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
      prepared: preparedExecution({
        projectDir,
        sessionId,
        feature: 'run over a red baseline',
        config,
      }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _implementer: implementer,
      _eventSink: (event) => events.push(event),
    });

    expect(readFileSync(join(projectDir, targetFile), 'utf-8')).toBe(
      'export const other = "unrelated";\n',
    );
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
      failed: 0,
    });

    expect(events.filter((event) => event.type === 'task_retry')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'escalate')).toHaveLength(0);
    expect(events.map((event) => event.type)).toContain('task_completed');

    const baselineDone = events.find(
      (event): event is Extract<EngineEvent, { type: 'validation_baseline' }> =>
        event.type === 'validation_baseline' && event.status === 'done',
    );
    expect(baselineDone?.failing?.test).toBe(true);

    const after = spawnSync('node', ['validate.mjs'], { cwd: projectDir, encoding: 'utf-8' });
    expect(after.status).not.toBe(0);
  }, 90_000);
});
