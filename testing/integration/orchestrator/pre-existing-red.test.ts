import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { readEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
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
import type { Config } from '../../../src/core/schemas/config.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../../src/engine/runners/prepared-execution.js';
import {
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';

const dirs: string[] = [];

beforeEach(() => {
  resetAllStores();
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function setupProject(): string {
  const projectDir = createTempDir('orch-int-pre-existing-red');
  dirs.push(projectDir);
  createTestGitRepo(projectDir, {
    'src/loop.ts': 'export const loop = "initial";\n',
    'package.json': `${JSON.stringify({ name: 'red-tree', private: true, scripts: { test: 'node validate.mjs' } })}\n`,
  });
  seedValidationProject(projectDir, 'from-retry');
  const script = join(projectDir, 'validate.mjs');
  writeFileSync(
    script,
    readFileSync(script, 'utf-8').replace(
      'src/loop.ts: expected from-retry implementation',
      'FAIL  src/loop.ts > loop > carries retry marker\\nAssertionError: expected from-retry implementation',
    ),
  );
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
    sourceConfig: config,
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

describe('a red that was there before the run', { timeout: 90_000 }, () => {
  it('runs no command before the first brief, checks the reviewer check red at the run base and routes it to no brief', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-pre-existing-red';
    const targetFile = 'src/other.ts';
    const redFile = 'src/loop.ts';
    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: [targetFile],
      title: 'Create a module that leaves the broken file alone',
      description:
        'Create a module in a project whose configured validation command is red before the run.',
      implementationSteps: ['Create src/other.ts with the module export.'],
      tests: ['node validate.mjs still fails for the pre-existing reason'],
      scope: { inBounds: [targetFile], outOfBounds: [redFile] },
      evidence: ['the review reports the red as pre-existing and starts no fix brief'],
      typeDefs: 'export const other: string',
    });

    const before = spawnSync('node', ['validate.mjs'], { cwd: projectDir, encoding: 'utf-8' });
    expect(before.status).not.toBe(0);

    const events: EngineEvent[] = [];
    // The reviewer chooses the project's own test command, which is red before the run.
    const planner = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks([task]),
        (prompt) => passingReviewVerdict(prompt),
        { plan: { inputTokens: 140, outputTokens: 90 } },
        () => ({
          commands: [{ id: 'V1', command: 'npm test', reason: 'The project tests every module.' }],
          declined: [],
          reason: null,
        }),
      ),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nThe red validation stage was red before the run.',
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
        endChecks: true,
        testCommand: 'node validate.mjs',
      },
      workflow: {
        approve: 'none',
      },
    });
    const summary = await runWorkflow({
      prepared: preparedExecution({
        projectDir,
        sessionId,
        feature: 'run over a red tree',
        config,
      }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _implementer: implementer,
      _eventSink: (event) => events.push(event),
    });

    expect(
      readFileSync(join(runWorkspaceDir({ projectDir, sessionId }), targetFile), 'utf-8'),
    ).toBe('export const other = "unrelated";\n');
    // No fix brief was appended for the pre-existing red.
    expect(summary).toMatchObject({ totalTasks: 1, completedByLocal: 1, failed: 0 });
    expect(events.filter((event) => event.type === 'task_retry')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'task_reset')).toHaveLength(0);

    const firstBrief = events.findIndex((event) => event.type === 'task_started');
    expect(firstBrief).toBeGreaterThan(-1);
    expect(events.slice(0, firstBrief).filter((event) => event.type === 'full_suite')).toEqual([]);

    // The same command text ran in the run workspace and at the run base, red both times.
    const checksDone = events.filter(
      (event): event is Extract<EngineEvent, { type: 'full_suite' }> =>
        event.type === 'full_suite' && event.status === 'done',
    );
    expect(
      checksDone.map((event) => [event.moment, event.id, event.command, event.passed]),
    ).toEqual([
      ['plan', 'T001-K1', 'node validate.mjs', false],
      ['pre-review', 'V1', 'npm test', false],
      ['base', 'V1', 'npm test', false],
    ]);

    const ledger = readEvidenceLedger({ projectDir, sessionId });
    const reviewerChecks = (
      ledger?.tasks.find((entry) => entry.id === 'T001')?.checks ?? []
    ).filter((entry) => entry.id === 'V1');
    expect(reviewerChecks.at(-1)?.preExisting).toEqual([
      'src/loop.ts::loop > carries retry marker',
    ]);

    const after = spawnSync('node', ['validate.mjs'], { cwd: projectDir, encoding: 'utf-8' });
    expect(after.status).not.toBe(0);
  }, 90_000);
});
