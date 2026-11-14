import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { ImplementerOptions, RetryOptions } from '../../../src/engine/implementers/types.js';
import type { ConsultAnswer } from '../../../src/core/schemas/consult.js';
import { formatRetryPrompt } from '../../../src/engine/spec/prompts/task.js';
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
  type RunnerGate,
} from '../../../src/engine/runners/prepare-execution/prepared.js';
import {
  cannotConsult,
  guidanceConsult,
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import { testCliSeats } from '#testing/helpers/runner-gate.js';

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

/** A second test that fails only where `src/other.ts` holds a broken module. */
const NEW_RED = [
  "import { existsSync as exists } from 'node:fs';",
  "if (exists('src/other.ts') && readFileSync('src/other.ts', 'utf-8').includes('broken')) {",
  "  console.error('FAIL  src/other.ts > other > stays whole\\nAssertionError: expected a whole module');",
  '  process.exitCode = 1;',
  '}',
].join('\n');

/** The red suite of `setupProject`, which also fails on a broken `src/other.ts`. */
function setupProjectWithNewRed(): string {
  const projectDir = setupProject();
  const script = join(projectDir, 'validate.mjs');
  const lines = readFileSync(script, 'utf-8').split('\n');
  writeFileSync(script, [lines[0], NEW_RED, ...lines.slice(1)].join('\n'));
  return projectDir;
}

/**
 * The red suite of `setupProject`, which also fails on `src/other.ts` the first time it runs in a
 * tree that has the module: `marker`, outside every tree, records that first run.
 */
function setupProjectWithFlakyNewRed(marker: string): string {
  const projectDir = setupProject();
  const script = join(projectDir, 'validate.mjs');
  const lines = readFileSync(script, 'utf-8').split('\n');
  const flaky = [
    "import { existsSync as exists, writeFileSync as write } from 'node:fs';",
    `if (exists('src/other.ts') && !exists(${JSON.stringify(marker)})) {`,
    `  write(${JSON.stringify(marker)}, '');`,
    "  console.error('FAIL  src/other.ts > other > stays whole\\nAssertionError: expected a whole module');",
    '  process.exitCode = 1;',
    '}',
  ].join('\n');
  writeFileSync(script, [lines[0], flaky, ...lines.slice(1)].join('\n'));
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
  const gates: RunnerGate[] = [
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
    gates,
    cliSeats: testCliSeats(gates),
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
  it('runs only the run base before the first brief, finds the reviewer check red there too and routes it to no brief', async () => {
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
      // The brief's own check passes: every red check fails its brief, and the red under test is
      // the plan gate's.
      checks: [{ id: 'T001-K1', kind: 'cmd', value: 'node --version' }],
    });

    const before = spawnSync('node', ['validate.mjs'], { cwd: projectDir, encoding: 'utf-8' });
    expect(before.status).not.toBe(0);

    const events: EngineEvent[] = [];
    // The plan names the project's own test command as its gate, and it is red before the run.
    const planner = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => ({ ...planFromTasks([task]), gate: ['npm test'] }),
        (prompt) => passingReviewVerdict(prompt),
        { plan: { inputTokens: 140, outputTokens: 90 } },
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
    expect(events.filter((event) => event.type === 'task_reset')).toHaveLength(0);

    const firstBrief = events.findIndex((event) => event.type === 'task_started');
    expect(firstBrief).toBeGreaterThan(-1);
    // The run base runs beside the build; no other check runs before the first brief.
    expect(
      events
        .slice(0, firstBrief)
        .filter((event) => event.type === 'full_suite' && event.moment !== 'base'),
    ).toEqual([]);

    // The same command text ran at the run base during the build and in the run workspace, red both
    // times.
    const checksDone = events.filter(
      (event): event is Extract<EngineEvent, { type: 'full_suite' }> =>
        event.type === 'full_suite' && event.status === 'done',
    );
    const row = (event: Extract<EngineEvent, { type: 'full_suite' }>) => [
      event.moment,
      event.id,
      event.command,
      event.passed,
    ];
    expect(checksDone.filter((event) => event.moment === 'base').map(row)).toEqual([
      ['base', 'V1', 'npm test', false],
    ]);
    expect(checksDone.filter((event) => event.moment !== 'base').map(row)).toEqual([
      ['plan', 'T001-K1', 'node --version', true],
      ['pre-review', 'V1', 'npm test', false],
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

describe('a brief check that runs the red suite of the project gate', { timeout: 90_000 }, () => {
  const OLD_RED = 'src/loop.ts::loop > carries retry marker';
  const NEW_RED_KEY = 'src/other.ts::other > stays whole';
  const targetFile = 'src/other.ts';

  async function runBrief(
    projectDir: string,
    content: string,
    answers: {
      consult?: (call: number) => ConsultAnswer;
      retry?: (opts: RetryOptions) => void;
    } = {},
  ) {
    const sessionId = 'sess-brief-pre-existing-red';
    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: [targetFile],
      title: 'Create a module that leaves the broken file alone',
      description: 'Create a module in a project whose test suite is red before the run.',
      implementationSteps: ['Create src/other.ts with the module export.'],
      tests: ['node validate.mjs still fails for the pre-existing reason'],
      scope: { inBounds: [targetFile], outOfBounds: ['src/loop.ts'] },
      evidence: ['the brief completes over the red that was there before the run'],
      typeDefs: 'export const other: string',
      // The brief check runs the test command, the same command text as the project gate.
      checks: [{ id: 'T001-K1', kind: 'test', value: targetFile }],
    });
    const consults: string[] = [];
    const events: EngineEvent[] = [];
    const planner = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => ({ ...planFromTasks([task]), gate: ['node validate.mjs'] }),
        (prompt) => passingReviewVerdict(prompt),
        { plan: { inputTokens: 140, outputTokens: 90 } },
        (prompt) => {
          consults.push(prompt);
          return answers.consult?.(consults.length) ?? cannotConsult();
        },
      ),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nThe red suite was red before the run.',
        usage: { inputTokens: 60, outputTokens: 30 },
      }),
    });
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, targetFile), content, 'utf-8');
        return {
          success: true,
          output: 'created the module',
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      }),
      retry: vi.fn().mockImplementation(async (opts: RetryOptions) => {
        answers.retry?.(opts);
        writeFileSync(join(opts.projectDir, targetFile), 'export const other = "whole";\n');
        return { success: true, output: 'fixed the module', usage: null };
      }),
    });
    const config = makeConfig({
      implementer: {
        kind: 'agent',
        command: 'node',
        model: 'cheap-direct-agent',
        contextLength: 4096,
      },
      validation: { endChecks: true, testCommand: 'node validate.mjs' },
      workflow: { approve: 'none' },
    });
    const summary = await runWorkflow({
      prepared: preparedExecution({
        projectDir,
        sessionId,
        feature: 'brief over a red tree',
        config,
      }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _implementer: implementer,
      _eventSink: (event) => events.push(event),
    });
    // The brief's own run of its check settles before the brief completes or escalates.
    const briefEnd = events.findIndex(
      (event) => event.type === 'task_completed' || event.type === 'task_escalating',
    );
    const briefRows = events
      .slice(0, briefEnd)
      .filter(
        (event): event is Extract<EngineEvent, { type: 'full_suite' }> =>
          event.type === 'full_suite' && event.id === 'T001-K1' && event.status === 'done',
      );
    return { summary, events, consults, briefRows };
  }

  it('completes the brief with no consult when every failure of its check is red at the run base', async () => {
    const projectDir = setupProject();

    const { summary, events, consults, briefRows } = await runBrief(
      projectDir,
      'export const other = "unrelated";\n',
    );

    expect(consults).toEqual([]);
    expect(events.filter((event) => event.type === 'task_escalating')).toEqual([]);
    expect(summary).toMatchObject({ totalTasks: 1, completedByLocal: 1, failed: 0 });
    const base = events.find(
      (event): event is Extract<EngineEvent, { type: 'full_suite' }> =>
        event.type === 'full_suite' && event.moment === 'base' && event.status === 'done',
    );
    expect(base).toMatchObject({ id: 'V1', command: 'node validate.mjs', passed: false });
    expect(briefRows).toMatchObject([
      {
        moment: 'plan',
        command: base?.command,
        passed: false,
        newFailures: 0,
        preExisting: 1,
        preExistingKeys: [OLD_RED],
      },
    ]);
  }, 90_000);

  it('fails the brief and consults on its new failure only when the suite also breaks a new test', async () => {
    const projectDir = setupProjectWithNewRed();

    const { events, consults, briefRows } = await runBrief(
      projectDir,
      'export const other = "broken";\n',
    );

    expect(events.some((event) => event.type === 'task_escalating')).toBe(true);
    expect(consults.length).toBeGreaterThan(0);
    expect(consults[0]).toContain(`New failures:\n- ${NEW_RED_KEY}\n`);
    expect(consults[0]).toContain(
      `Pre-existing failures (also red at the run base):\n- ${OLD_RED}\n`,
    );
    expect(briefRows).toMatchObject([
      { passed: false, newFailures: 1, preExisting: 1, newKeys: [NEW_RED_KEY] },
    ]);
  }, 90_000);

  it('passes the final review over a brief check whose every failure is red at the run base', async () => {
    const projectDir = setupProject();

    const { events } = await runBrief(projectDir, 'export const other = "unrelated";\n');

    const review = events.slice(events.findIndex((event) => event.type === 'task_completed'));
    expect(review.filter((event) => event.type === 'seat_answer_refused')).toEqual([]);
    expect(review.filter((event) => event.type === 'workflow_complete')).toMatchObject([
      { review: 'passed' },
    ]);
    expect(
      review.filter(
        (event): event is Extract<EngineEvent, { type: 'full_suite' }> =>
          event.type === 'full_suite' && event.id === 'T001-K1' && event.status === 'done',
      ),
    ).toMatchObject([
      {
        moment: 'plan',
        passed: false,
        newFailures: 0,
        preExisting: 1,
        preExistingKeys: [OLD_RED],
      },
    ]);
    expect(review.flatMap((event) => (event.type === 'checks_run' ? event.results : []))).toEqual([
      { id: 'T001-K1', status: 'pass' },
    ]);
  }, 90_000);

  it('completes the brief on a consult verify whose re-run leaves only the failures red at the run base', async () => {
    const markerDir = createTempDir('orch-int-flaky-marker');
    dirs.push(markerDir);
    const projectDir = setupProjectWithFlakyNewRed(join(markerDir, 'ran-once'));

    const { events, consults } = await runBrief(projectDir, 'export const other = "flaky";\n', {
      consult: (call) =>
        call === 1
          ? {
              answer: {
                diagnosis: 'The new failure looks flaky',
                action: 'verify',
                checkIds: ['T001-K1'],
                reason: 'Run the suite again',
              },
            }
          : cannotConsult(),
    });

    expect(consults).toHaveLength(1);
    expect(events.filter((event) => event.type === 'task_completed')).toMatchObject([
      { taskId: 'T001', method: 'consulted' },
    ]);
  }, 90_000);

  it('names the pre-existing failures apart in the retry prompt after a consult', async () => {
    const projectDir = setupProjectWithNewRed();
    const prompts: string[] = [];

    await runBrief(projectDir, 'export const other = "broken";\n', {
      consult: (call) =>
        call === 1 ? guidanceConsult('Keep src/other.ts whole.') : cannotConsult(),
      retry: (opts) => prompts.push(formatRetryPrompt(opts)),
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(
      `Error from previous attempt:\ncheck T001-K1 did not pass (fail): 2 failures\nNew failures:\n- ${NEW_RED_KEY}\n`,
    );
    expect(prompts[0]).toContain(
      `Pre-existing failures (also red at the run base):\n- ${OLD_RED}\n`,
    );
  }, 90_000);
});
