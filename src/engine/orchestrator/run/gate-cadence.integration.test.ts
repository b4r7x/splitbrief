import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  makeCopyingIsolation,
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import {
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
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
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import type { ReviewChecksPlan } from '../../../core/schemas/review.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { runTasksAndReview } from './task-execution.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
    fixCycles: { used: 0, notes: [] },
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
 * One ordered log of what the run did: every check command, every reviewer-check row, every
 * implementer call and every review call. The reviewer chooses `checks` before each review.
 */
function runHarness(opts: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  config: Config;
  checks: ReviewChecksPlan | ((prompt: string) => ReviewChecksPlan);
  runCommand: (line: string, cwd: string | undefined) => void;
}) {
  const log: string[] = [];
  const events: EngineEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((event) => {
    events.push(event);
    if (event.type === 'review_checks') log.push(`checks:${event.scope}:${event.status}`);
    if (event.type === 'full_suite') log.push(`check:${event.id}:${event.moment}:${event.status}`);
  });
  const reviewPrompts: string[] = [];
  const triagePrompts: string[] = [];
  const checksPrompts: string[] = [];
  const reviewer = makePlanner({
    typedCall: typedCallPlanAndReview(
      () => planFromTasks(opts.state.tasks),
      (prompt) => {
        log.push('review');
        reviewPrompts.push(prompt);
        const verdict = passingReviewVerdict(prompt);
        const pending = prompt.split('## Pending Inputs')[1]?.split('\n## ')[0] ?? '';
        const findingIds = [...pending.matchAll(/^- \*\*(\S+)\*\*/gm)].map(
          (match) => match[1] ?? '',
        );
        if (findingIds.length === 0) return verdict;
        triagePrompts.push(prompt);
        return {
          ...verdict,
          fixTasks: [
            {
              ...makeTaskSpec({
                id: 'T003',
                criteria: [],
                checks: [],
                suggestedFiles: ['src/alpha.ts'],
              }),
              findingIds,
            },
          ],
        };
      },
      undefined,
      (prompt) => {
        checksPrompts.push(prompt);
        return typeof opts.checks === 'function' ? opts.checks(prompt) : opts.checks;
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
        call.task.fix !== undefined
          ? FIXED
          : file === 'src/alpha.ts'
            ? BROKEN
            : 'export const value = 1;\n',
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
  vi.spyOn(commandRunner, 'runCommand').mockImplementation(async (cmd, args, options) => {
    const line = [cmd, ...args].join(' ');
    log.push(`cmd:${line}`);
    opts.runCommand(line, options?.cwd);
    return { stdout: '', stderr: '', code: 0 };
  });
  const wctx = makeWctx({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    isolation: makeCopyingIsolation({ projectDir: opts.projectDir, sessionId: opts.sessionId }),
    config: opts.config,
    callbacks: makeCallbacks().callbacks,
    bus,
    planner: reviewer,
    reviewer,
    implementer,
  });
  return {
    log,
    events,
    reviewPrompts,
    triagePrompts,
    checksPrompts,
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
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    },
  };
}

/** The `## Reviewer checks` section the verdict call carries. */
function reviewerChecksSection(prompt: string | undefined): string {
  return prompt?.split('## Reviewer checks\n')[1]?.split('\n## ')[0] ?? '';
}

const TYPECHECK: ReviewChecksPlan = {
  commands: [{ id: 'V1', command: 'tsc --noEmit', reason: 'the project type checks' }],
  declined: [],
  reason: null,
};

describe("reviewer checks with workflow.review 'end'", { timeout: 120_000 }, () => {
  it('runs no check before the final review, then lets the reviewer append a fix task for a red one brief owns', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], criteria: ['C2'] }),
    ];
    const harness = runHarness({
      projectDir,
      sessionId,
      state: gateState(tasks, head),
      config: makeConfig({ workflow: {} }),
      checks: TYPECHECK,
      runCommand: (line, cwd) => {
        if (line === 'tsc --noEmit' && alphaIsBroken(cwd)) {
          throw processError.exitCode({ command: line, code: 2, stderr: TYPE_ERROR });
        }
      },
    });

    const result = await runTasksAndReview(harness.options);

    expect(result.completed).toBe(true);
    // No command after either brief: the reviewer's plan is the first thing that runs one.
    const firstPlan = harness.log.indexOf('checks:final:planned');
    expect(firstPlan).toBeGreaterThan(-1);
    const beforePlan = harness.log.slice(0, firstPlan);
    expect(beforePlan.filter((entry) => entry.startsWith('cmd:'))).toEqual([]);
    expect(beforePlan.filter((entry) => entry.startsWith('retry:'))).toEqual([]);
    expect(harness.implemented).toEqual(['T001', 'T002', 'T003']);
    expect(harness.retries).toEqual([]);
    expect(harness.triagePrompts[0]).toContain('TS2304');
    expect(harness.triagePrompts[0]).toContain('V1.1');
    expect(result.state.fixCycles?.used).toBe(1);
    // The reviewer's check runs again before the second review, and passes.
    const verdicts = harness.events.flatMap((event) =>
      event.type === 'full_suite' && event.moment === 'pre-review' && event.status === 'done'
        ? [event.passed]
        : [],
    );
    expect(verdicts).toEqual([false, true]);
    expect(harness.reviewPrompts).toHaveLength(2);
    expect(reviewerChecksSection(harness.reviewPrompts[0])).toContain(
      `- V1 \`tsc --noEmit\`: failed, 1 new failure(s)\ncheck V1 did not pass (fail): 1 failure\nFailures:\n- ${TYPE_ERROR.split(':')[0]}`,
    );
    expect(reviewerChecksSection(harness.reviewPrompts[1])).toContain(
      '- V1 `tsc --noEmit`: passed',
    );
    expect(reviewerChecksSection(harness.reviewPrompts[1])).not.toContain('failed');
    expect(harness.log.indexOf('review')).toBeLessThan(harness.log.indexOf('implement:T003'));
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done', 'done']);
  });
});

describe("reviewer checks with workflow.review 'task'", { timeout: 120_000 }, () => {
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
  const RELATED: ReviewChecksPlan = {
    commands: [
      {
        id: 'V1',
        command: 'npx --no-install vitest run src/alpha.test.ts',
        reason: 'the test of the changed file',
      },
    ],
    declined: [{ target: 'src/beta.test.ts', reason: 'the task did not touch beta' }],
    reason: null,
  };

  it('keeps each fix command across reviewer re-plans that reuse V1', async () => {
    const { projectDir, sessionId, head } = setupProject(TS_PROJECT);
    const tasks = [
      makeTask({
        id: 'T001',
        suggestedFiles: ['src/alpha.ts'],
        criteria: ['C1'],
        fix: {
          cycle: 1,
          findings: [
            {
              id: 'V1.1',
              text: 'The type check failed',
              acceptance: null,
              checkIds: ['V1'],
              commands: { V1: 'tsc --noEmit' },
            },
          ],
        },
      }),
      makeTask({
        id: 'T002',
        suggestedFiles: ['src/beta.ts'],
        criteria: ['C2'],
        fix: {
          cycle: 2,
          findings: [
            {
              id: 'V1.2',
              text: 'The tests failed',
              acceptance: null,
              checkIds: ['V1'],
              commands: { V1: 'npm test' },
            },
          ],
        },
      }),
    ];
    const latestChecks: ReviewChecksPlan = {
      commands: [{ id: 'V1', command: 'node --version', reason: 'the runtime answers' }],
      declined: [],
      reason: null,
    };
    const harness = runHarness({
      projectDir,
      sessionId,
      state: {
        ...gateState(tasks, head),
        fixCycles: { used: 2, notes: [] },
        reviewChecks: {
          scope: 'task',
          cycle: 2,
          plan: latestChecks,
          at: '2026-10-08T00:00:00.000Z',
        },
      },
      config: makeConfig({ workflow: { review: 'task' } }),
      checks: (prompt) => {
        const required = ['tsc --noEmit', 'npm test'].filter((command) =>
          prompt.includes(`- \`${command}\``),
        );
        return {
          ...latestChecks,
          commands: [...required, 'node --version'].map((command, index) => ({
            id: `V${index + 1}`,
            command,
            reason: 'Verifies the fix and the runtime.',
          })),
        };
      },
      runCommand: () => {},
    });

    const result = await runTasksAndReview(harness.options);

    expect(result.completed).toBe(true);
    expect(harness.implemented).toEqual(['T001', 'T002']);
    expect(harness.retries).toEqual([]);
    expect(
      harness.events.flatMap((event) =>
        event.type === 'full_suite' && event.moment === 'brief' && event.status === 'done'
          ? [[event.id, event.command, event.passed]]
          : [],
      ),
    ).toEqual([
      ['V1', 'tsc --noEmit', true],
      ['V1', 'npm test', true],
    ]);
    const betweenFixes = harness.log.slice(
      harness.log.indexOf('implement:T001'),
      harness.log.indexOf('implement:T002'),
    );
    // The task review takes the fix check's result: no file changed since it ran.
    expect(betweenFixes.filter((entry) => entry.startsWith('cmd:'))).toEqual([
      'cmd:tsc --noEmit',
      'cmd:node --version',
    ]);
    expect(betweenFixes).toContain('checks:task:planned');
    expect(harness.checksPrompts[0]).toContain('- `tsc --noEmit`');
    expect(harness.checksPrompts[1]).toContain('- `npm test`');
    expect(result.state.pendingReviewCommands ?? []).toEqual([]);
    expect(result.state.tasks.map((task) => task.checkResults)).toEqual([
      [{ id: 'V1', status: 'pass' }],
      [{ id: 'V1', status: 'pass' }],
    ]);
  });

  it("runs the related test the reviewer chose before the task's scheduled review, and names the one it declined", async () => {
    const { projectDir, sessionId, head } = setupProject(TS_PROJECT);
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], criteria: ['C2'] }),
    ];
    const harness = runHarness({
      projectDir,
      sessionId,
      state: gateState(tasks, head),
      config: makeConfig({ workflow: { review: 'task' } }),
      checks: RELATED,
      runCommand: () => {},
    });

    const result = await runTasksAndReview(harness.options);

    expect(result.completed).toBe(true);
    const scheduledReview = harness.log.indexOf('review');
    expect(scheduledReview).toBeGreaterThan(-1);
    const beforeReview = harness.log.slice(0, scheduledReview);
    expect(beforeReview.indexOf('implement:T001')).toBeLessThan(
      beforeReview.indexOf('checks:task:planned'),
    );
    expect(beforeReview.filter((entry) => entry.startsWith('cmd:'))).toEqual([
      'cmd:npx --no-install vitest run src/alpha.test.ts',
    ]);
    expect(beforeReview).toContain('check:V1:pre-review:done');
    expect(
      harness.events.find((event) => event.type === 'review_checks' && event.scope === 'task'),
    ).toMatchObject({
      status: 'planned',
      declined: [{ target: 'src/beta.test.ts', reason: 'the task did not touch beta' }],
    });
    // The first task review covers T001: its plan call lists only the files T001 changed, and its
    // reviewer check lands on T001's ledger entry, not on the last task of the run.
    const firstChecks = harness.checksPrompts[0] ?? '';
    expect(firstChecks).toContain('The review covers the changes of T001.');
    expect(firstChecks).toContain('## Changed files\n\n- src/alpha.ts');
    expect(firstChecks).not.toContain('src/beta.ts');
    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(
      ledger?.tasks.find((entry) => entry.id === 'T001')?.checks?.map((check) => check.id),
    ).toContain('V1');
  });

  it("hands a red related test to the task's review as a pending input", async () => {
    const { projectDir, sessionId, head } = setupProject(TS_PROJECT);
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] })];
    const harness = runHarness({
      projectDir,
      sessionId,
      state: gateState(tasks, head),
      config: makeConfig({ workflow: { review: 'task' } }),
      checks: RELATED,
      runCommand: (line, cwd) => {
        if (line.includes('src/alpha.test.ts') && alphaIsBroken(cwd)) {
          throw processError.exitCode({ command: line, code: 1, stderr: TEST_FAILURE });
        }
      },
    });

    const result = await runTasksAndReview(harness.options);

    expect(result.completed).toBe(true);
    expect(harness.retries).toEqual([]);
    expect(harness.triagePrompts[0]).toContain('V1.1');
    expect(harness.triagePrompts[0]).toContain('src/alpha.test.ts');
    expect(harness.implemented).toEqual(['T001', 'T002']);
    expect(result.state.fixCycles?.used).toBe(1);
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
  });
});
