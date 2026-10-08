import { afterEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeCopyingIsolation,
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import {
  failedReviewVerdict,
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { readReviewRecord } from '../../../core/review/store.js';
import { REVIEW_FILE, sessionDir } from '../../../core/paths.js';
import { loadState } from '../../../core/state/persistence.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ReviewVerdict, TriageResult } from '../../../core/schemas/review.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { runTasksAndReview } from './task-execution.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string; head: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'task-cadence-review',
    sessionId: 'sess-cadence',
  });
  dirs.push(projectDir);
  const head = execSync('git rev-parse HEAD', {
    cwd: projectDir,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  return { projectDir, sessionId, head };
}

function cadenceState(
  tasks: readonly Task[],
  head: string,
  overrides?: Partial<WorkflowState>,
): WorkflowState {
  return makeImplState([...tasks], {
    changedFilesBaseline: { head, fingerprints: {}, runStartChangedFiles: [] },
    plan: {
      summary: 'Two briefs, one criterion each',
      decisions: [],
      criteria: [
        { id: 'C1', text: 'The first brief works', checkIds: [] },
        { id: 'C2', text: 'The second brief works', checkIds: [] },
      ],
      checks: [],
      validation: null,
    },
    ...overrides,
  });
}

function runOptions(opts: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  review: (prompt: string, call: number) => ReviewVerdict;
  triage?: ((prompt: string, call: number) => TriageResult | string) | undefined;
  onComplete: () => void;
  config?: Config | undefined;
  phases?: string[] | undefined;
  artifacts?: Array<{ json: string | undefined; markdown: boolean }> | undefined;
}) {
  const ref = { projectDir: opts.projectDir, sessionId: opts.sessionId };
  const { bus, events } = makeBusRecorder();
  const reviewPrompts: string[] = [];
  const triagePrompts: string[] = [];
  const reviewer = makePlanner({
    typedCall: typedCallPlanAndReview(
      () => planFromTasks(opts.state.tasks),
      (prompt, call) => {
        reviewPrompts.push(prompt);
        opts.phases?.push(loadState(ref)?.phase ?? 'missing');
        opts.artifacts?.push({
          json: readReviewRecord(ref)?.outcome,
          markdown: existsSync(join(sessionDir(ref.projectDir, ref.sessionId), REVIEW_FILE)),
        });
        const verdict = opts.review(prompt, call);
        if (
          opts.triage === undefined ||
          (verdict.findings.length === 0 && prompt.includes('## Pending Inputs\nNone.'))
        )
          return verdict;
        const fixWork = opts.triage(prompt, call);
        triagePrompts.push(prompt);
        return typeof fixWork === 'string' ? fixWork : { ...verdict, ...fixWork };
      },
    ),
  });
  const implementer = makeImplementer({
    implement: vi.fn().mockImplementation(async (call: ImplementerOptions) => {
      const file = call.task.suggestedFiles[0];
      mkdirSync(join(call.projectDir, dirname(file)), { recursive: true });
      writeFileSync(join(call.projectDir, file), `export const value = ${Date.now()};\n`);
      return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
    }),
  });
  const wctx = makeWctx({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    isolation: makeCopyingIsolation({ projectDir: opts.projectDir, sessionId: opts.sessionId }),
    config: opts.config ?? makeNoValidationConfig({ workflow: { review: 'task' } }),
    callbacks: makeCallbacks({ onComplete: opts.onComplete }).callbacks,
    bus,
    planner: reviewer,
    reviewer,
    implementer,
  });
  return {
    ref,
    events,
    reviewPrompts,
    triagePrompts,
    options: {
      wctx,
      state: opts.state,
      planning: {
        disposition: 'ready-for-tasks' as const,
        state: opts.state,
        tasks: opts.state.tasks,
      },
      summaryBase: {
        feature: 'cadence',
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

describe("runTasksAndReview workflow.review 'task'", { timeout: 120_000 }, () => {
  it('scopes each scheduled review to the completed briefs and due criteria', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], criteria: ['C2'] }),
    ];
    const onComplete = vi.fn();
    const phases: string[] = [];
    const artifacts: Array<{ json: string | undefined; markdown: boolean }> = [];
    const { events, reviewPrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: cadenceState(tasks, head),
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete,
      phases,
      artifacts,
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(reviewPrompts).toHaveLength(3);
    expect(reviewPrompts[0]).toContain('Task ids: T001\nCriterion ids: C1');
    expect(reviewPrompts[0]).not.toContain('Task ids: T001, T002');
    expect(reviewPrompts[1]).toContain('Task ids: T001, T002\nCriterion ids: C1, C2');
    expect(reviewPrompts[2]).toContain('Task ids: T001, T002\nCriterion ids: C1, C2');
    expect(phases).toEqual(['implementing', 'implementing', 'final-review']);
    expect(artifacts).toEqual([
      { json: undefined, markdown: false },
      { json: 'pass', markdown: true },
      { json: 'pass', markdown: true },
    ]);
    expect(events.filter((event) => event.type === 'all_tasks_done')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'workflow_complete')).toHaveLength(1);
    expect(result.state.fixCycles?.used ?? 0).toBe(0);
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
  });

  it('triages a scheduled failure into an appended fix task and stays implementing', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] })];
    const onComplete = vi.fn();
    const phases: string[] = [];
    const { events, reviewPrompts, triagePrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: cadenceState(tasks, head),
      review: (prompt, call) =>
        call === 1
          ? failedReviewVerdict(prompt, 'src/alpha.ts drops the error', { taskId: 'T001' })
          : passingReviewVerdict(prompt),
      triage: () => ({
        fixTasks: [
          {
            ...makeTaskSpec({
              id: 'T002',
              suggestedFiles: ['src/shared/widget.ts'],
              criteria: [],
              checks: [{ id: 'K2', kind: 'cmd', value: 'node --version', required: true }],
            }),
            findingIds: ['F1'],
          },
        ],
        rejected: [],
        verify: [],
        ask: null,
      }),
      onComplete,
      phases,
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(reviewPrompts).toHaveLength(3);
    expect(triagePrompts).toHaveLength(1);
    expect(result.state.tasks[1]?.fix?.findings[0]?.text).toBe('src/alpha.ts drops the error');
    const fixed = result.state.tasks[1];
    expect(fixed?.id).toBe('T002');
    expect(fixed?.fix?.cycle).toBe(1);
    expect(fixed?.fix?.findings.map((finding) => finding.id)).toEqual(['F1']);
    expect(result.state.fixCycles?.used).toBe(1);
    expect(phases).toEqual(['implementing', 'implementing', 'final-review']);
    expect(events.filter((event) => event.type === 'review_fix_started')).toEqual([
      expect.objectContaining({ cycle: 1, taskIds: ['T002'] }),
    ]);
    expect(events.filter((event) => event.type === 'workflow_complete')).toEqual([
      expect.objectContaining({ review: 'passed' }),
    ]);
  });

  it("keeps the unchanged 'end' cadence to one final review", async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], criteria: ['C2'] }),
    ];
    const phases: string[] = [];
    const { events, reviewPrompts, triagePrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: cadenceState(tasks, head),
      config: makeNoValidationConfig({ workflow: {} }),
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
      phases,
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(true);
    expect(reviewPrompts).toHaveLength(1);
    expect(reviewPrompts[0]).toContain('Task ids: T001, T002\nCriterion ids: C1, C2');
    expect(phases).toEqual(['final-review']);
    expect(triagePrompts).toHaveLength(0);
    expect(events.filter((event) => event.type === 'all_tasks_done')).toHaveLength(1);
  });

  it('halts on the cap when a scheduled failure has no fix cycle left', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], criteria: ['C2'] }),
    ];
    const onComplete = vi.fn();
    const { events, triagePrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: cadenceState(tasks, head, {
        fixCycles: { used: 2, allowance: 2, notes: [] },
      }),
      review: (prompt) =>
        failedReviewVerdict(prompt, 'src/alpha.ts drops the error', { taskId: 'T001' }),
      onComplete,
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    expect(triagePrompts).toHaveLength(0);
    expect(result.state.phase).toBe('implementing');
    expect(result.state.reviewStatus).toBeUndefined();
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'review-failed',
      message: 'Final review failed after 2 fix cycles',
    });
    expect(events.find((event) => event.type === 'workflow_complete')).toBeUndefined();
    expect(result.state.review?.scope).toBe('task');
    expect(result.state.pendingTriage).toBeDefined();
    expect(result.state.pendingRecovery?.availableActions).not.toContain('accept-as-is');
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'pending']);
    const corrected = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: result.state,
      action: 'revise',
      bus: options.wctx.bus,
      comment: 'Keep running with the reviewed correction',
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error(corrected.message);
    const phases: string[] = [];
    const continued = runOptions({
      projectDir,
      sessionId,
      state: corrected.state,
      review: (prompt) => passingReviewVerdict(prompt),
      triage: () => ({
        fixTasks: [],
        rejected: [{ findingId: 'U2', reason: 'The correction guides continuation' }],
        verify: [],
        ask: null,
      }),
      onComplete,
      phases,
    });
    const completed = await runTasksAndReview(continued.options);
    expect(completed.completed).toBe(true);
    expect(completed.state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
    expect(continued.triagePrompts).toHaveLength(1);
    expect(continued.triagePrompts[0]).toContain('Keep running with the reviewed correction');
    expect(continued.reviewPrompts).toHaveLength(3);
    expect(phases).toEqual(['implementing', 'implementing', 'final-review']);
    expect(continued.events.filter((event) => event.type === 'workflow_complete')).toEqual([
      expect.objectContaining({ review: 'passed' }),
    ]);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
