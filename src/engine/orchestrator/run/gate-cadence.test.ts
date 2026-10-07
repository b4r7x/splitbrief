import { afterEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import {
  passingReviewVerdict,
  planFromTasks,
  rejectingTriageResult,
  typedCallPlanReviewAndTriage,
} from '#testing/helpers/typed-planner.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { processError } from '../../../lib/process/errors.js';
import { createEventBus } from '../../events/bus.js';
import type { EngineEvent } from '../../events/types.js';
import type { ImplementerOptions, RetryOptions } from '../../implementers/types.js';
import { createValidator } from '../validation/run.js';
import type { ValidationCommandRunner } from '../validation/types.js';
import { runTasksAndReview } from './task-execution.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

const BROKEN = 'export const alpha = BROKEN;\n';
const FIXED = 'export const alpha = 1;\n';
const TYPE_ERROR = "src/alpha.ts(1,22): error TS2304: Cannot find name 'BROKEN'.";
const TEST_FAILURE =
  'FAIL src/alpha.test.ts > alpha > works\nAssertionError at src/alpha.test.ts:3:5';

function setupProject(files?: Record<string, string>) {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'gate-cadence-run',
    sessionId: 'sess-gate-run',
    ...(files !== undefined && { files }),
  });
  dirs.push(projectDir);
  const head = execSync('git rev-parse HEAD', {
    cwd: projectDir,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  return { projectDir, sessionId, head };
}

function gateState(tasks: readonly Task[], head: string): WorkflowState {
  return makeImplState([...tasks], {
    changedFilesBaseline: { head, fingerprints: {}, runStartChangedFiles: [] },
    fixCycles: { used: 0, allowance: 2, notes: [] },
    plan: {
      summary: 'Gate cadence',
      decisions: [],
      criteria: tasks.map((task, index) => ({
        id: `C${index + 1}`,
        text: `${task.id} works`,
        checkIds: [],
      })),
      checks: [],
      validation: null,
    },
  });
}

function alphaIsBroken(cwd: string | undefined): boolean {
  const file = join(cwd ?? '', 'src/alpha.ts');
  return existsSync(file) && readFileSync(file, 'utf8').includes('BROKEN');
}

/**
 * One ordered log of what the run did: every gate command, every suite and
 * validate event, every implementer call and every review call.
 */
function runHarness(opts: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  config: Config;
  runCommand: (line: string, cwd: string | undefined) => void;
}) {
  const log: string[] = [];
  const events: EngineEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((event) => {
    events.push(event);
    if (event.type === 'full_suite') log.push(`suite:${event.moment}:${event.status}`);
    if (event.type === 'validate') log.push(`validate:${event.taskId}:${event.status}`);
  });
  const reviewPrompts: string[] = [];
  const triagePrompts: string[] = [];
  const reviewer = makePlanner({
    typedCall: typedCallPlanReviewAndTriage(
      () => planFromTasks(opts.state.tasks),
      (prompt) => {
        log.push('review');
        reviewPrompts.push(prompt);
        return passingReviewVerdict(prompt);
      },
      (prompt) => {
        triagePrompts.push(prompt);
        return rejectingTriageResult(prompt);
      },
    ),
  });
  const implemented: string[] = [];
  const retries: RetryOptions[] = [];
  const implementer = makeImplementer({
    implement: vi.fn().mockImplementation(async (call: ImplementerOptions) => {
      log.push(`implement:${call.task.id}`);
      implemented.push(call.task.id);
      const file = call.task.suggestedFiles[0] ?? 'src/missing.ts';
      mkdirSync(join(call.projectDir, dirname(file)), { recursive: true });
      writeFileSync(
        join(call.projectDir, file),
        file === 'src/alpha.ts' ? BROKEN : 'export const value = 1;\n',
      );
      return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
    }),
    retry: vi.fn().mockImplementation(async (call: RetryOptions) => {
      log.push(`retry:${call.task.id}`);
      retries.push(call);
      mkdirSync(join(call.projectDir, 'src'), { recursive: true });
      writeFileSync(join(call.projectDir, 'src/alpha.ts'), FIXED);
      return { success: true, output: 'fixed', usage: { inputTokens: 10, outputTokens: 5 } };
    }),
  });
  const runCommand: ValidationCommandRunner = async (cmd, args, options) => {
    const line = [cmd, ...args].join(' ');
    log.push(`cmd:${line}`);
    opts.runCommand(line, options?.cwd);
    return { stdout: '', stderr: '', code: 0 };
  };
  const wctx = makeWctx({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    config: opts.config,
    callbacks: makeCallbacks().callbacks,
    bus,
    planner: reviewer,
    reviewer,
    implementer,
    validator: createValidator({ runCommand }),
  });
  return {
    log,
    events,
    reviewPrompts,
    triagePrompts,
    implemented,
    retries,
    options: {
      wctx,
      state: opts.state,
      planning: {
        disposition: 'ready-for-tasks' as const,
        state: opts.state,
        tasks: opts.state.tasks,
      },
      summaryBase: {
        feature: 'gate cadence',
        startTime: Date.now() - 1000,
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      phaseTimings: {} as Record<string, number>,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    },
  };
}

describe("gates with workflow.review 'end'", { timeout: 120_000 }, () => {
  it('runs the gates once at the final review and sends a red owned by one brief back to that brief', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], criteria: ['C2'] }),
    ];
    const harness = runHarness({
      projectDir,
      sessionId,
      state: gateState(tasks, head),
      config: makeConfig({
        validation: {
          typecheck: true,
          lint: false,
          test: false,
          typecheckCommand: 'npx tsc --noEmit',
        },
        workflow: {},
      }),
      runCommand: (line, cwd) => {
        if (line === 'npx tsc --noEmit' && alphaIsBroken(cwd)) {
          throw processError.exitCode({ command: line, code: 2, stderr: TYPE_ERROR });
        }
      },
    });

    const result = await runTasksAndReview(harness.options);

    expect(result.completed).toBe(true);
    // No gate after either brief: the first pre-review suite is the first gate after the baseline.
    const firstPreReview = harness.log.indexOf('suite:pre-review:running');
    expect(firstPreReview).toBeGreaterThan(-1);
    const beforePreReview = harness.log.slice(0, firstPreReview);
    expect(beforePreReview.filter((entry) => entry.startsWith('validate:'))).toEqual([]);
    expect(beforePreReview.filter((entry) => entry.startsWith('retry:'))).toEqual([]);
    expect(harness.implemented).toEqual(['T001', 'T002']);
    // The red names src/alpha.ts, which only T001 changed: T001 gets the exact errors, no triage.
    expect(harness.retries).toHaveLength(1);
    expect(harness.retries[0]?.task.id).toBe('T001');
    expect(harness.retries[0]?.error).toContain('TS2304');
    expect(harness.triagePrompts).toEqual([]);
    expect(result.state.fixCycles?.used).toBe(1);
    // The gates run again before the review: the second pre-review suite is green.
    const preReviewVerdicts = harness.events.flatMap((event) =>
      event.type === 'full_suite' && event.moment === 'pre-review' && event.status === 'done'
        ? [event.passed]
        : [],
    );
    expect(preReviewVerdicts).toEqual([false, true]);
    expect(harness.reviewPrompts).toHaveLength(1);
    expect(harness.log.indexOf('review')).toBeGreaterThan(harness.log.indexOf('retry:T001'));
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
  });
});

describe("gates with workflow.review 'task'", { timeout: 120_000 }, () => {
  const TS_PROJECT = {
    'package.json': JSON.stringify({
      name: 'gate-cadence',
      scripts: { test: 'vitest run' },
      devDependencies: { typescript: '^5.0.0' },
    }),
    'tsconfig.json': '{}\n',
    'src/alpha.test.ts': "import { alpha } from './alpha.js';\n",
    'src/beta.test.ts': "import { beta } from './beta.js';\n",
  };

  // No configured test command: the test stage resolves from the manifest, which narrows to
  // the task's related test files.
  function taskConfig(): Config {
    const config = makeConfig({
      validation: {
        typecheck: true,
        lint: true,
        test: true,
        typecheckCommand: 'npx tsc --noEmit',
        lintCommand: 'npx biome check .',
      },
      workflow: { review: 'task' },
    });
    const { testCommand: _configured, ...validation } = config.validation;
    return { ...config, validation };
  }

  it("runs only the task's related tests after the task, then its scheduled review", async () => {
    const { projectDir, sessionId, head } = setupProject(TS_PROJECT);
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] })];
    const harness = runHarness({
      projectDir,
      sessionId,
      state: gateState(tasks, head),
      config: taskConfig(),
      runCommand: () => {},
    });

    const result = await runTasksAndReview(harness.options);

    expect(result.completed).toBe(true);
    const afterBaseline = harness.log.slice(harness.log.lastIndexOf('suite:baseline:done') + 1);
    const scheduledReview = afterBaseline.indexOf('review');
    expect(scheduledReview).toBeGreaterThan(-1);
    const taskGate = afterBaseline.slice(0, scheduledReview);
    const commands = taskGate.filter((entry) => entry.startsWith('cmd:'));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('src/alpha.test.ts');
    expect(commands[0]).not.toContain('src/beta.test.ts');
    expect(taskGate).not.toContain('suite:pre-review:running');
    expect(taskGate).toContain('validate:T001:done');
    // The final review still runs the full gates once.
    expect(
      harness.log.filter((entry) => entry === 'suite:pre-review:running').length,
    ).toBeGreaterThan(0);
    expect(harness.log.indexOf('suite:pre-review:running')).toBeGreaterThan(
      harness.log.indexOf('review'),
    );
  });

  it("sends a red related test straight to the task's retry ladder before its review", async () => {
    const { projectDir, sessionId, head } = setupProject(TS_PROJECT);
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] })];
    const harness = runHarness({
      projectDir,
      sessionId,
      state: gateState(tasks, head),
      config: taskConfig(),
      runCommand: (line, cwd) => {
        if (line.includes('src/alpha.test.ts') && alphaIsBroken(cwd)) {
          throw processError.exitCode({ command: line, code: 1, stderr: TEST_FAILURE });
        }
      },
    });

    const result = await runTasksAndReview(harness.options);

    expect(result.completed).toBe(true);
    expect(harness.retries).toHaveLength(1);
    expect(harness.retries[0]?.error).toContain('src/alpha.test.ts');
    const firstReview = harness.log.indexOf('review');
    expect(harness.log.indexOf('retry:T001')).toBeGreaterThan(-1);
    expect(harness.log.indexOf('retry:T001')).toBeLessThan(firstReview);
    expect(harness.log.slice(0, firstReview)).not.toContain('suite:pre-review:running');
    expect(harness.triagePrompts).toEqual([]);
    expect(result.state.fixCycles?.used ?? 0).toBe(0);
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done']);
  });

  it('reruns the pre-review typecheck red in the brief gate of the reopened brief', async () => {
    const { projectDir, sessionId, head } = setupProject(TS_PROJECT);
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] })];
    const harness = runHarness({
      projectDir,
      sessionId,
      state: gateState(tasks, head),
      config: taskConfig(),
      runCommand: (line, cwd) => {
        if (line === 'npx tsc --noEmit' && alphaIsBroken(cwd)) {
          throw processError.exitCode({ command: line, code: 2, stderr: TYPE_ERROR });
        }
      },
    });

    const result = await runTasksAndReview(harness.options);

    expect(result.completed).toBe(true);
    expect(harness.retries.map((retry) => retry.task.id)).toEqual(['T001']);
    expect(harness.retries[0]?.error).toContain('TS2304');
    expect(result.state.fixCycles?.used).toBe(1);
    // The reopened attempt's own gate reruns typecheck before the next pre-review suite.
    const reopened = harness.log.indexOf('retry:T001');
    const nextPreReview = harness.log.indexOf('suite:pre-review:running', reopened);
    expect(nextPreReview).toBeGreaterThan(reopened);
    expect(harness.log.slice(reopened, nextPreReview)).toContain('cmd:npx tsc --noEmit');
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done']);
  });
});
