import { plainUserMessage } from '../../../core/types/user-input.js';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  cannotConsult,
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
import type { Plan } from '../../../core/schemas/plan.js';
import type { ReviewVerdict, TriageResult } from '../../../core/schemas/review/verdict.js';
import { taskId, type Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { TriageRecord } from '../../../core/schemas/workflow/review-record.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { formatRecoveryHeadline } from '../../../core/recovery/headline.js';
import { applyRecoveryAction } from '../recovery/actions/apply.js';
import { appendMessage } from '../../../core/sessions/log/writer.js';
import { makeMessage } from '#testing/helpers/queue.js';
import type { ContinuationHolder } from '../continuation/holder.js';
import { resumeContinuation } from './init/resume-repair.js';
import { runTasksAndReview } from './task-execution.js';

let dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(files?: Record<string, string>): {
  projectDir: string;
  sessionId: string;
  head: string;
} {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'task-cadence-review',
    sessionId: 'sess-cadence',
    files,
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
  criteria: Plan['criteria'] = [
    { id: 'C1', text: 'The first brief works', checkIds: [] },
    { id: 'C2', text: 'The second brief works', checkIds: [] },
  ],
): WorkflowState {
  return makeImplState([...tasks], {
    changedFilesBaseline: { head, fingerprints: {}, runStartChangedFiles: [] },
    plan: {
      summary: 'Two briefs, one criterion each',
      decisions: [],
      criteria,
      checks: [],
      validation: null,
    },
    ...overrides,
  });
}

/**
 * The `scope` answer that started fix cycle 2 against `blocking` with fix task `fixTaskId`: the
 * review that judges that task and fails on them again moved nothing.
 */
function stuckRecord(blocking: string[], scope: 'task' | 'final'): TriageRecord {
  return {
    cycle: 2,
    at: '2026-10-03T00:00:00Z',
    inputIds: [],
    result: {
      fixTasks: [{ ...makeTaskSpec({ id: 'T900' }), findingIds: ['F1'] }],
      rejected: [],
      ask: null,
    },
    blocking,
    scope,
  };
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
  continuation?: ContinuationHolder | undefined;
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
      undefined,
      () => cannotConsult(),
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
    ...(opts.continuation !== undefined && { continuation: opts.continuation }),
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
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    },
  };
}

describe("runTasksAndReview workflow.review 'task'", { timeout: 120_000 }, () => {
  it('announces two anchored fixes before their cycle and execution, including pending plan work', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = Array.from({ length: 5 }, (_, index) =>
      makeTask({
        id: `T${String(index + 1).padStart(3, '0')}`,
        suggestedFiles: [`src/planned-${index + 1}.ts`],
        criteria: [index < 4 ? 'C1' : 'C2'],
      }),
    );
    const { events, ref, options } = runOptions({
      projectDir,
      sessionId,
      state: cadenceState(tasks, head),
      review: (prompt, call) => {
        if (call !== 4) return passingReviewVerdict(prompt);
        const verdict = failedReviewVerdict(prompt, 'Overdue lookup needs coverage', {
          taskId: 'T004',
        });
        return {
          ...verdict,
          findings: [
            ...verdict.findings,
            ...verdict.findings.map((finding) => ({
              ...finding,
              id: 'F2',
              text: 'Overdue boundary needs coverage',
            })),
          ],
        };
      },
      triage: () => ({
        fixTasks: ['T006', 'T007'].map((id, index) => ({
          ...makeTaskSpec({
            id,
            suggestedFiles: [`src/${id}.ts`],
            criteria: [],
            checks: [{ id: `${id}-K1`, kind: 'cmd', value: 'node --version' }],
          }),
          findingIds: [`F${index + 1}`],
        })),
        rejected: [],
        ask: null,
      }),
      onComplete: vi.fn(),
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(true);
    const order = ['T001', 'T002', 'T003', 'T004', 'T006', 'T007', 'T005'];
    const announcementIndex = events.findIndex(
      (event) => event.type === 'tasks_planned' && event.total === 7,
    );
    expect(announcementIndex).toBeGreaterThan(-1);
    expect(events[announcementIndex]).toMatchObject({
      total: 7,
      tasks: order.map((id, index) => ({ id, index })),
    });
    expect(announcementIndex).toBeLessThan(
      events.findIndex((event) => event.type === 'review_fix_started'),
    );
    expect(announcementIndex).toBeLessThan(
      events.findIndex((event) => event.type === 'task_started' && event.taskId === 'T006'),
    );
    expect(
      events.filter((event) => event.type === 'task_started').map((event) => event.taskId),
    ).toEqual(order);
    expect(loadState(ref)?.tasks.map((task) => task.id)).toEqual(order);
  });

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
      config: makeNoValidationConfig({
        workflow: { review: 'task' },
        reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      }),
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
    const starts = events.filter((event) => event.type === 'review_started');
    const completions = events.filter((event) => event.type === 'review_completed');
    expect(starts).toHaveLength(3);
    expect(completions).toHaveLength(3);
    for (const [index, afterTaskId] of ['T001', 'T002', undefined].entries()) {
      const scope = afterTaskId === undefined ? 'final' : 'task';
      const start = starts[index];
      const completion = completions[index];
      expect(start).toMatchObject({
        scope,
        tool: 'codex',
        model: 'gpt-6.1-sol',
        axes: ['high'],
        ...(afterTaskId !== undefined && { afterTaskId }),
      });
      expect(completion).toMatchObject({
        scope,
        tool: 'codex',
        model: 'gpt-6.1-sol',
        axes: ['high'],
        verdict: 'pass',
        findings: { blocking: 0, minor: 0, outOfScope: 0 },
        ...(afterTaskId !== undefined && { afterTaskId }),
      });
      expect(completion?.duration).toBeGreaterThanOrEqual(0);
      const startIndex = events.findIndex((event) => event === start);
      const completionIndex = events.findIndex((event) => event === completion);
      expect(completionIndex).toBeGreaterThan(startIndex);
      expect(
        events
          .slice(startIndex, completionIndex + 1)
          .some((event) => event.type === 'planner_status'),
      ).toBe(false);
      if (afterTaskId !== undefined) {
        const taskCompleted = events.findIndex(
          (event) => event.type === 'task_completed' && event.taskId === afterTaskId,
        );
        const next = events.findIndex((event) =>
          index === 0
            ? event.type === 'task_started' && event.taskId === 'T002'
            : event.type === 'review_started' && event.scope === 'final',
        );
        expect(startIndex).toBeGreaterThan(taskCompleted);
        expect(next).toBeGreaterThan(completionIndex);
      } else {
        expect(start).not.toHaveProperty('afterTaskId');
        expect(completion).not.toHaveProperty('afterTaskId');
        expect(events.findIndex((event) => event.type === 'workflow_complete')).toBeGreaterThan(
          completionIndex,
        );
      }
    }
    expect(
      events.filter((event) => event.type === 'planner_status' && event.tool === 'codex'),
    ).toEqual([]);
    expect(result.state.fixCycles?.used ?? 0).toBe(0);
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
  });

  it('halts a task review on a required check whose program is missing, then runs the review once it is installed', async () => {
    const missing = 'splitbrief-missing-runner';
    const { projectDir, sessionId, head } = setupProject({
      'package.json': `${JSON.stringify({ name: 'cadence', private: true, scripts: { test: missing } })}\n`,
    });
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], criteria: ['C2'] }),
    ];
    const state = cadenceState(tasks, head, {
      plan: {
        summary: 'Two briefs, the first checked by the test script',
        decisions: [],
        criteria: [
          { id: 'C1', text: 'The first brief works', checkIds: ['K1'] },
          { id: 'C2', text: 'The second brief works', checkIds: [] },
        ],
        checks: [{ id: 'K1', kind: 'cmd', value: 'npm test' }],
        validation: null,
      },
    });
    const onComplete = vi.fn();
    const { events, reviewPrompts, options } = runOptions({
      projectDir,
      sessionId,
      state,
      review: (prompt) => {
        const verdict = passingReviewVerdict(prompt);
        return {
          ...verdict,
          criteria: verdict.criteria.map((criterion) =>
            criterion.id === 'C1'
              ? { ...criterion, status: 'unverified' as const, evidence: 'K1 did not run' }
              : criterion,
          ),
        };
      },
      onComplete,
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(false);
    expect(reviewPrompts).toHaveLength(0);
    const halt = result.state.pendingRecovery;
    if (halt === undefined) throw new Error('Missing halt');
    expect(halt.reason).toBe('required-checks-unrunnable');
    expect(halt.message).toMatch(/^Checks cannot run: K1: /);
    expect(halt.details).toContain('Install what is missing, then run the checks again.');
    expect(halt.availableActions).toEqual(['retry-same-worker', 'end-run']);
    const errors = events.flatMap((event) => (event.type === 'error' ? [event] : []));
    expect(errors.map((event) => event.code)).toEqual(['required_checks_unrunnable']);
    expect(events.some((event) => event.type === 'review_started')).toBe(false);
    expect(result.state.phase).toBe('implementing');
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done', 'pending']);

    const bin = join(projectDir, '.bin');
    mkdirSync(bin);
    writeFileSync(join(bin, missing), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, missing), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
    const retried = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: result.state,
      action: 'retry-same-worker',
      bus: options.wctx.bus,
    });
    if (!retried.ok) throw new Error(retried.message);
    const continued = runOptions({
      projectDir,
      sessionId,
      state: retried.state,
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete,
    });
    const completed = await runTasksAndReview(continued.options);

    expect(completed.completed).toBe(true);
    expect(continued.reviewPrompts).toHaveLength(3);
    expect(continued.reviewPrompts[0]).toContain('Task ids: T001\nCriterion ids: C1');
    expect(completed.state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it.each([
    { route: 'task', review: 'task' as const, failsFrom: 2 },
    { route: 'final', review: 'end' as const, failsFrom: 1 },
  ])(
    'gives the $route review a Review again note while a required check still fails',
    async ({ review, failsFrom }) => {
      const { projectDir, sessionId, head } = setupProject({
        'package.json': `${JSON.stringify({ name: 'cadence', private: true, scripts: { test: 'test ! -f src/beta.ts' } })}\n`,
      });
      const tasks = [
        makeTask({
          id: 'T001',
          suggestedFiles: ['src/alpha.ts'],
          criteria: ['C1'],
          checks: [{ id: 'T001-K1', kind: 'cmd', value: 'npm test' }],
        }),
        makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], criteria: ['C2'] }),
      ];
      const config = makeNoValidationConfig({ workflow: { review } });
      const pendingIds = (prompt: string) => [
        ...new Set(
          [...(prompt.split('## Pending Inputs')[1] ?? '').matchAll(/\*\*([PUA]\d+)\*\*/g)].map(
            (match) => match[1] ?? '',
          ),
        ),
      ];
      const rejectPending = (prompt: string) =>
        pendingIds(prompt).map((findingId) => ({ findingId, reason: 'not a defect' }));
      const onComplete = vi.fn();
      const first = runOptions({
        projectDir,
        sessionId,
        state: cadenceState(tasks, head, {
          fixCycles: { used: 2, notes: [], open: { cycle: 2, lastFixTaskId: taskId('T002') } },
          triage: [stuckRecord(['finding:F1'], review === 'task' ? 'task' : 'final')],
        }),
        review: (prompt, call) =>
          call < failsFrom
            ? passingReviewVerdict(prompt)
            : failedReviewVerdict(prompt, 'Beta breaks alpha', { taskId: 'T002' }),
        triage: (prompt) => ({
          fixTasks: failedReviewVerdict(prompt, 'Beta breaks alpha', { taskId: 'T002' }).fixTasks,
          rejected: rejectPending(prompt),
          ask: null,
        }),
        onComplete,
        config,
      });

      const halted = await runTasksAndReview(first.options);

      expect(halted.state.pendingRecovery?.reason).toBe('review-failed');
      expect(halted.state.pendingTriage?.inputs.map((input) => input.id)).toEqual(['P1']);
      const retried = await applyRecoveryAction({
        projectDir,
        sessionId,
        state: halted.state,
        action: 'revise',
        comment: plainUserMessage('Also rename beta'),
        bus: first.options.wctx.bus,
      });
      if (!retried.ok) throw new Error(retried.message);
      const second = runOptions({
        projectDir,
        sessionId,
        state: retried.state,
        review: (prompt) => passingReviewVerdict(prompt),
        triage: (prompt) => ({
          fixTasks: [],
          rejected: rejectPending(prompt),
          ask: null,
        }),
        onComplete,
        config,
      });

      await runTasksAndReview(second.options);

      expect(pendingIds(second.reviewPrompts[0] ?? '')).toEqual(['P1', 'U3']);
      expect(second.reviewPrompts[0]).toContain('Also rename beta');
    },
  );

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
              checks: [{ id: 'K2', kind: 'cmd', value: 'node --version' }],
            }),
            findingIds: ['F1'],
          },
        ],
        rejected: [],
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
    const failed = events.filter(
      (event) => event.type === 'review_completed' && event.verdict === 'fail',
    );
    expect(failed).toEqual([
      expect.objectContaining({
        scope: 'task',
        afterTaskId: 'T001',
        verdict: 'fail',
        findings: { blocking: 1, minor: 0, outOfScope: 0 },
      }),
    ]);
    expect(events.findIndex((event) => event.type === 'review_fix_started')).toBeGreaterThan(
      events.findIndex((event) => event === failed[0]),
    );
    expect(events.filter((event) => event.type === 'review_fix_started')).toEqual([
      expect.objectContaining({ cycle: 1, taskIds: ['T002'] }),
    ]);
    expect(events.filter((event) => event.type === 'workflow_complete')).toEqual([
      expect.objectContaining({ review: 'passed' }),
    ]);
  });

  it('fixes the reviewed task without duplicating a pending task', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', status: 'done', criteria: ['C1'] }),
      makeTask({ id: 'T002', status: 'done', criteria: ['C2'] }),
      makeTask({ id: 'T003', status: 'done', criteria: ['C3'] }),
      makeTask({
        id: 'T004',
        suggestedFiles: ['src/time-zone.ts'],
        criteria: ['C4', 'C6'],
      }),
      makeTask({
        id: 'T005',
        suggestedFiles: ['src/pending.ts'],
        criteria: ['C10', 'C11'],
      }),
    ];
    const criteria = ['C1', 'C2', 'C3', 'C4', 'C6', 'C10', 'C11'].map((id) => ({
      id,
      text: `${id} works`,
      checkIds: [],
    }));
    const onComplete = vi.fn();
    let taskReviewMarkdown = '';
    const { reviewPrompts, triagePrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: cadenceState(tasks, head, { currentTaskIndex: 3 }, criteria),
      review: (prompt, call) => {
        if (call === 3) {
          taskReviewMarkdown = readFileSync(
            join(sessionDir(projectDir, sessionId), REVIEW_FILE),
            'utf8',
          );
        }
        if (call > 2) return passingReviewVerdict(prompt);
        return {
          ...passingReviewVerdict(prompt),
          findings: [
            ...failedReviewVerdict(prompt, 'C10/C11 are not implemented').findings,
            ...failedReviewVerdict(prompt, 'T004 has no time-zone tests', {
              id: 'F2',
              taskId: 'T004',
              criterionId: 'C6',
            }).findings,
          ],
        };
      },
      triage: (_prompt, call) => ({
        fixTasks: [
          ...(call === 1
            ? [
                {
                  ...makeTaskSpec({
                    id: 'T900',
                    suggestedFiles: ['src/pending.ts'],
                    criteria: [],
                    checks: [{ id: 'K-pending', kind: 'cmd', value: 'node --version' }],
                  }),
                  findingIds: ['F1'],
                },
              ]
            : []),
          {
            ...makeTaskSpec({
              id: 'T901',
              suggestedFiles: ['src/time-zone.test.ts'],
              criteria: ['C6'],
              checks: [{ id: 'K-time-zone', kind: 'cmd', value: 'node --version' }],
            }),
            findingIds: ['F2'],
          },
        ],
        rejected: [],
        ask: null,
      }),
      onComplete,
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(reviewPrompts[1]).toContain('It failed validation:');
    expect(reviewPrompts[1]).toContain(
      'Finding F1 is outside the task review scope and cannot be assigned to a fix task.',
    );
    expect(triagePrompts).toHaveLength(2);
    expect(
      result.state.tasks
        .filter((task) => task.criteria?.some((id) => id === 'C10' || id === 'C11'))
        .map((task) => task.id),
    ).toEqual(['T005']);
    expect(
      result.state.tasks.flatMap((task) => task.fix?.findings.map((finding) => finding.id) ?? []),
    ).not.toContain('F1');
    const fixTasks = result.state.tasks.filter((task) => task.fix !== undefined);
    expect(fixTasks).toHaveLength(1);
    const fixTask = fixTasks[0];
    expect(fixTask?.fix?.findings.map((finding) => finding.id)).toEqual(['F2']);
    expect(fixTask?.criteria).toEqual(['C6']);
    expect(result.state.tasks.map((task) => task.id)).toEqual([
      'T001',
      'T002',
      'T003',
      'T004',
      fixTask?.id,
      'T005',
    ]);
    expect(
      vi.mocked(options.wctx.implementer.implement).mock.calls.map(([call]) => call.task.id),
    ).toEqual(['T004', fixTask?.id, 'T005']);
    expect(taskReviewMarkdown).toContain(
      'Outside the task review scope: C10/C11 are not implemented',
    );
  });

  it('None skips the task review', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const config = makeNoValidationConfig({ reviewer: 'none', workflow: { review: 'task' } });
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], criteria: ['C2'] }),
    ];
    const { events, reviewPrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: cadenceState(tasks, head),
      config,
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(true);
    expect(reviewPrompts).toEqual([]);
    expect(events.some((event) => event.type === 'review_started')).toBe(false);
    expect(result.state.reviewStatus).toBe('none');
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

  it('names the task review that reached no verdict, not the final review', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], criteria: ['C2'] }),
    ];
    const { events, options } = runOptions({
      projectDir,
      sessionId,
      state: cadenceState(tasks, head),
      review: () => {
        throw new Error('reviewer exited with code 1');
      },
      onComplete: vi.fn(),
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(false);
    expect(result.state.phase).toBe('implementing');
    const halt = result.state.pendingRecovery;
    if (halt === undefined) throw new Error('Missing halt');
    expect(halt.reason).toBe('review-failed');
    expect(formatRecoveryHeadline(halt)).toBe('Review T001 reached no verdict');
    expect(halt.message).toMatch(/^Review T001 failed: /);
    const errors = events.flatMap((event) => (event.type === 'error' ? [event.message] : []));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Review T001 failed: /);
  });

  it('halts a scheduled failure whose fix cycle left the same blockers', async () => {
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
        fixCycles: { used: 2, notes: [], open: { cycle: 2, lastFixTaskId: taskId('T001') } },
        triage: [stuckRecord(['finding:F1'], 'task')],
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
      message: 'Review T001 made no progress on F1 after fix cycle 2',
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
      comment: plainUserMessage('Keep running with the reviewed correction'),
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
        rejected: [{ findingId: 'U3', reason: 'The correction guides continuation' }],
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

describe('a task review left pending, on a continue after a move to REVIEW None', {
  timeout: 120_000,
}, () => {
  const noneConfig = () =>
    makeNoValidationConfig({ reviewer: 'none', workflow: { review: 'task' } });
  const pendingReview = { pendingScheduledReview: { afterTaskId: taskId('T001') } };

  function continueOnNone(
    project: ReturnType<typeof setupProject>,
    state: WorkflowState,
    continuation?: ContinuationHolder,
  ) {
    return runOptions({
      projectDir: project.projectDir,
      sessionId: project.sessionId,
      state,
      config: noneConfig(),
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
      continuation,
    });
  }

  const WORDS = 'mind the lockfile';
  const T001 = () =>
    makeTask({ id: 'T001', status: 'done', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] });
  const T002 = () => makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], criteria: ['C2'] });

  /** Who read the words: each implementer call, its steer, and whether its call holds them. */
  function briefCalls(run: ReturnType<typeof continueOnNone>) {
    return vi.mocked(run.options.wctx.implementer.implement).mock.calls.map(([call]) => ({
      task: call.task.id,
      steer: call.continuation?.steer,
      wordsRead: JSON.stringify(call).includes(WORDS),
    }));
  }

  function stoppedInReview(
    project: ReturnType<typeof setupProject>,
    tasks: Task[],
    cut: 'mid-step' | 'boundary',
  ) {
    appendMessage(
      { projectDir: project.projectDir, sessionId: project.sessionId },
      { role: 'assistant', phase: 'implementing', text: 'half a review', interrupted: true },
    );
    return cadenceState(tasks, project.head, {
      currentTaskIndex: 1,
      ...pendingReview,
      interruptedStep: {
        step: { kind: 'review', cycle: 0 },
        source: 'user',
        at: '2026-11-09T00:00:00.000Z',
        cut,
      },
    });
  }

  async function seedSteer(
    project: ReturnType<typeof setupProject>,
    state: WorkflowState,
    reviewNone: boolean,
  ) {
    return resumeContinuation({
      ref: { projectDir: project.projectDir, sessionId: project.sessionId },
      state,
      steer: plainUserMessage(WORDS),
      reviewNone,
    });
  }

  const savedNote = (state: WorkflowState) =>
    (state.pendingTriage?.inputs ?? []).filter((input) => input.source === 'user');

  function expectNoReviewRan(run: ReturnType<typeof continueOnNone>, state: WorkflowState) {
    expect(run.reviewPrompts).toEqual([]);
    expect(run.events.some((event) => event.type === 'review_started')).toBe(false);
    expect(state.reviewStatus).toBe('none');
    expect(state.pendingScheduledReview).toBeUndefined();
    expect(state.pendingTriage).toBeUndefined();
    expect(state.pendingRecovery).toBeUndefined();
    expect(loadState(run.ref)?.pendingScheduledReview).toBeUndefined();
  }

  // One real task review with a seat that fails and whose fix cycle moved nothing: the run halts
  // on the planner's refusal, and the saved state keeps the review, its triage and the anchor.
  async function haltedTaskReview(project: ReturnType<typeof setupProject>) {
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], criteria: ['C2'] }),
    ];
    const seat = runOptions({
      projectDir: project.projectDir,
      sessionId: project.sessionId,
      state: cadenceState(tasks, project.head, {
        fixCycles: { used: 2, notes: [], open: { cycle: 2, lastFixTaskId: taskId('T001') } },
        triage: [stuckRecord(['finding:F1'], 'task')],
      }),
      review: (prompt) =>
        failedReviewVerdict(prompt, 'src/alpha.ts drops the error', { taskId: 'T001' }),
      onComplete: vi.fn(),
    });
    const halted = await runTasksAndReview(seat.options);
    expect(halted.state.pendingRecovery?.reason).toBe('review-failed');
    expect(halted.state.pendingScheduledReview).toEqual({ afterTaskId: 'T001' });
    return { state: halted.state, bus: seat.options.wctx.bus };
  }

  it('drops the task review when no brief is left, and the run ends', async () => {
    const project = setupProject();
    const tasks = [
      makeTask({ id: 'T001', status: 'done', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] }),
    ];
    const run = continueOnNone(
      project,
      cadenceState(tasks, project.head, { currentTaskIndex: 1, ...pendingReview }),
    );

    const pass = runTasksAndReview(run.options);

    await expect(pass).resolves.toMatchObject({ completed: true });
    expectNoReviewRan(run, (await pass).state);
  });

  it('drops the task review and runs the next brief', async () => {
    const project = setupProject();
    const tasks = [
      makeTask({ id: 'T001', status: 'done', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'], criteria: ['C2'] }),
    ];
    const run = continueOnNone(
      project,
      cadenceState(tasks, project.head, { currentTaskIndex: 1, ...pendingReview }),
    );

    const pass = runTasksAndReview(run.options);

    await expect(pass).resolves.toMatchObject({ completed: true });
    const { state } = await pass;
    expectNoReviewRan(run, state);
    expect(state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
  });

  it('does not run the checks of the dropped review', async () => {
    const missing = 'splitbrief-missing-runner';
    const project = setupProject({
      'package.json': `${JSON.stringify({ name: 'cadence', private: true, scripts: { test: missing } })}\n`,
    });
    const tasks = [
      makeTask({ id: 'T001', status: 'done', suggestedFiles: ['src/alpha.ts'], criteria: ['C1'] }),
    ];
    const run = continueOnNone(
      project,
      cadenceState(tasks, project.head, {
        currentTaskIndex: 1,
        ...pendingReview,
        plan: {
          summary: 'One brief, checked by the test script',
          decisions: [],
          criteria: [{ id: 'C1', text: 'The brief works', checkIds: ['K1'] }],
          checks: [{ id: 'K1', kind: 'cmd', value: 'npm test' }],
          validation: null,
        },
      }),
    );

    const pass = runTasksAndReview(run.options);

    await expect(pass).resolves.toMatchObject({ completed: true });
    expectNoReviewRan(run, (await pass).state);
    expect(run.events.some((event) => event.type === 'error')).toBe(false);
  });

  it('does not ask the question of the dropped review', async () => {
    const project = setupProject();
    const { state } = await haltedTaskReview(project);
    const run = continueOnNone(project, {
      ...state,
      pendingRecovery: undefined,
      pendingTriage: {
        inputs: [],
        question: { question: 'Which error?', whyOnlyUserCanAnswer: 'Only the user knows' },
      },
    });
    const onPlannerReply = vi.fn().mockResolvedValue(plainUserMessage('The first one'));
    run.options.wctx.callbacks.onPlannerReply = onPlannerReply;

    const pass = runTasksAndReview(run.options);

    await expect(pass).resolves.toMatchObject({ completed: true });
    expectNoReviewRan(run, (await pass).state);
    expect(onPlannerReply).not.toHaveBeenCalled();
  });

  it('does not ask the planner on the dropped review', async () => {
    const project = setupProject();
    const { state } = await haltedTaskReview(project);
    const run = continueOnNone(project, {
      ...state,
      pendingRecovery: undefined,
      pendingTriage: { inputs: [], plannerConsult: true },
    });

    const pass = runTasksAndReview(run.options);

    await expect(pass).resolves.toMatchObject({ completed: true });
    expectNoReviewRan(run, (await pass).state);
  });

  it('continues a halt of the task review that the user answered', async () => {
    const project = setupProject();
    const { state, bus } = await haltedTaskReview(project);
    const corrected = await applyRecoveryAction({
      projectDir: project.projectDir,
      sessionId: project.sessionId,
      state,
      action: 'revise',
      bus,
      comment: plainUserMessage('Keep running with the reviewed correction'),
    });
    if (!corrected.ok) throw new Error(corrected.message);
    expect(corrected.state.pendingScheduledReview).toEqual({ afterTaskId: 'T001' });
    const run = continueOnNone(project, corrected.state);

    const pass = runTasksAndReview(run.options);

    await expect(pass).resolves.toMatchObject({ completed: true });
    const { state: ended } = await pass;
    expectNoReviewRan(run, ended);
    expect(ended.tasks.map((task) => task.status)).toEqual(['done', 'done']);
  });

  it.each(['mid-step', 'boundary'] as const)(
    'hands a correction typed at rest after a %s stop to the next brief',
    async (cut) => {
      const project = setupProject();
      const state = stoppedInReview(project, [T001(), T002()], cut);
      const run = continueOnNone(project, state, await seedSteer(project, state, true));

      const pass = runTasksAndReview(run.options);

      await expect(pass).resolves.toMatchObject({ completed: true });
      expectNoReviewRan(run, (await pass).state);
      expect(briefCalls(run)).toEqual([{ task: 'T002', steer: WORDS, wordsRead: true }]);
    },
  );

  it('keeps a correction typed at rest for the review on a run with a seat', async () => {
    const project = setupProject();
    const holder = await seedSteer(
      project,
      stoppedInReview(project, [T001(), T002()], 'mid-step'),
      false,
    );

    expect(holder.take({ kind: 'review', cycle: 0 })?.steer?.text).toBe(WORDS);
  });

  it('hands a note typed on the failed review after the move to the next brief', async () => {
    const project = setupProject();
    const { state, bus } = await haltedTaskReview(project);
    const note = plainUserMessage(WORDS);
    const corrected = await applyRecoveryAction({
      projectDir: project.projectDir,
      sessionId: project.sessionId,
      state,
      action: 'revise',
      bus,
      config: noneConfig(),
      comment: note,
    });
    if (!corrected.ok) throw new Error(corrected.message);
    expect(corrected).toMatchObject({ correctionRecorded: false });
    expect(savedNote(corrected.state)).toEqual([]);
    const seeded = await resumeContinuation({
      ref: { projectDir: project.projectDir, sessionId: project.sessionId },
      state: corrected.state,
      steer: note,
      reviewNone: true,
    });
    const run = continueOnNone(project, corrected.state, seeded);

    const pass = runTasksAndReview(run.options);

    await expect(pass).resolves.toMatchObject({ completed: true });
    expectNoReviewRan(run, (await pass).state);
    expect(briefCalls(run).at(-1)).toEqual({ task: 'T002', steer: WORDS, wordsRead: true });
  });

  it('keeps the note of Review again for the review on a run with a seat', async () => {
    const project = setupProject();
    const { state, bus } = await haltedTaskReview(project);
    const corrected = await applyRecoveryAction({
      projectDir: project.projectDir,
      sessionId: project.sessionId,
      state,
      action: 'revise',
      bus,
      config: makeNoValidationConfig({ workflow: { review: 'task' } }),
      comment: plainUserMessage(WORDS),
    });
    if (!corrected.ok) throw new Error(corrected.message);

    expect(corrected).toMatchObject({ correctionRecorded: true });
    expect(savedNote(corrected.state).map((input) => input.text)).toEqual([WORDS]);
  });

  it('hands a note saved for the review before the move to the next brief', async () => {
    const project = setupProject();
    const { state, bus } = await haltedTaskReview(project);
    const corrected = await applyRecoveryAction({
      projectDir: project.projectDir,
      sessionId: project.sessionId,
      state,
      action: 'revise',
      bus,
      comment: plainUserMessage(WORDS),
    });
    if (!corrected.ok) throw new Error(corrected.message);
    expect(savedNote(corrected.state)).toHaveLength(1);
    const run = continueOnNone(project, corrected.state);

    const pass = runTasksAndReview(run.options);

    await expect(pass).resolves.toMatchObject({ completed: true });
    expectNoReviewRan(run, (await pass).state);
    expect(briefCalls(run).at(-1)?.wordsRead).toBe(true);
  });

  it('queues no message for a note saved for the review when no brief is left', async () => {
    const project = setupProject();
    const run = continueOnNone(
      project,
      cadenceState([T001()], project.head, {
        currentTaskIndex: 1,
        ...pendingReview,
        pendingTriage: {
          inputs: [{ id: 'U1', kind: 'defect', source: 'user', text: WORDS, file: null }],
        },
      }),
    );

    const pass = runTasksAndReview(run.options);

    await expect(pass).resolves.toMatchObject({ completed: true });
    const { state } = await pass;
    expectNoReviewRan(run, state);
    expect(state.messageQueue).toEqual([]);
  });

  it('gives a message queued for the review before the move to the next brief', async () => {
    const project = setupProject();
    const run = continueOnNone(
      project,
      cadenceState([T001(), T002()], project.head, {
        currentTaskIndex: 1,
        ...pendingReview,
        messageQueue: [{ ...makeMessage(WORDS), id: 'pending' }],
      }),
    );

    const pass = runTasksAndReview(run.options);

    await expect(pass).resolves.toMatchObject({ completed: true });
    expectNoReviewRan(run, (await pass).state);
    expect(briefCalls(run)[0]).toMatchObject({ task: 'T002', wordsRead: true });
  });
});
