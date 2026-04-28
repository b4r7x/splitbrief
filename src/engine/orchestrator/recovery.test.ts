import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { SESSION_LOG_FILE, sessionDir } from '../../core/paths.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { createEventBus } from '../events/bus.js';
import { createJsonlSink } from '../events/sinks/jsonl.js';
import type { EngineEvent, EventBus } from '../events/types.js';
import { readEvidenceLedger } from './evidence.js';
import type { RoutingDecision } from './context-routing.js';
import { createApprovalPromotionConflict, classifyUserEditConflict } from './user-edit-conflicts.js';
import { RecoveryIssueSchema } from '../../core/schemas/recovery.js';
import {
  applyRecoveryAction,
  buildApprovalPromotionConflictRecoveryIssue,
  buildBudgetExceededRecoveryIssue,
  buildBudgetPausedRecoveryIssue,
  buildContextOverflowRecoveryIssue,
  buildDependencyBlockedRecoveryIssue,
  buildImplementationErrorRecoveryIssue,
  buildRetryExhaustedRecoveryIssue,
  buildUserEditConflictRecoveryIssue,
  buildValidationFailedRecoveryIssue,
} from './recovery.js';

const createdAt = '2026-04-28T12:00:00.000Z';
const selectedAt = '2026-04-28T12:05:00.000Z';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function expectValidRecoveryIssue(issue: unknown): void {
  const result = RecoveryIssueSchema.safeParse(issue);
  expect(result.success).toBe(true);
}

function overflowRoutingDecision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    taskId: makeTask().id,
    requiredWriteMode: 'extracted-code',
    fit: 'overflow',
    estimatedTokens: 45_000,
    untruncatedEstimatedTokens: 48_000,
    contextLength: 32_768,
    currentCodeTruncated: false,
    currentCodeContextMode: 'whole-file',
    costPosture: 'No capable implementer profile; no cost tier selected',
    reason: 'No capable implementer profile can fit this task prompt',
    rejected: [
      {
        profile: 'local-qwen',
        costTier: 'local',
        profileWriteMode: 'extracted-code',
        requiredWriteMode: 'extracted-code',
        reason: 'Estimated 45000 tokens overflows 32768-token context',
        fit: 'overflow',
        estimatedTokens: 45_000,
        untruncatedEstimatedTokens: 48_000,
        contextLength: 32_768,
        currentCodeTruncated: false,
        currentCodeContextMode: 'whole-file',
      },
    ],
    ...overrides,
  };
}

function setupSession(name = 'recovery-action'): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  const sessionId = `sess-${name}`;
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function makeBus(projectDir: string, sessionId: string): { bus: EventBus; events: EngineEvent[] } {
  const bus = createEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe(event => events.push(event));
  bus.subscribe(createJsonlSink(projectDir, sessionId, true));
  return { bus, events };
}

function implementingState(tasks: Task[], currentTaskIndex = 0): WorkflowState {
  let state = createInitialState('feat');
  state = transition(state, { type: 'START', feature: 'feat' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks });
  state = transition(state, { type: 'APPROVE_PLAN' });
  return { ...state, currentTaskIndex };
}

function readSessionLog(projectDir: string, sessionId: string): string {
  return readFileSync(join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE), 'utf-8');
}

describe('recovery issue builders', () => {
  it('builds implementation-error issues with retry, route, task, and error details', () => {
    const task = makeTask({ id: 'T010', title: 'Patch auth flow', file: 'src/auth.ts' });

    const issue = buildImplementationErrorRecoveryIssue({
      task,
      createdAt,
      error: new Error('worker returned empty output'),
      attempts: 1,
      maxAttempts: 3,
      selectedImplementerProfile: 'local-qwen',
      routeBiggerProfile: 'cheap-cloud',
    });

    expect(issue).toMatchObject({
      reason: 'implementation-error',
      phase: 'implementing',
      taskId: task.id,
      taskTitle: 'Patch auth flow',
      selectedImplementerProfile: 'local-qwen',
      recommendedAction: 'retry-same-worker',
    });
    expect(issue.files).toEqual(['src/auth.ts']);
    expect(issue.affectedTaskIds).toEqual([task.id]);
    expect(issue.details).toContain('Error: worker returned empty output');
    expect(issue.details).toContain('Attempts: 1/3');
    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'route-bigger-worker',
      'skip-current-task',
      'pause-run',
      'abort-workflow',
    ]);
    expectValidRecoveryIssue(issue);
  });

  it('builds validation-failed issues with validation summary and retry budget filtering', () => {
    const task = makeTask({ id: 'T011', file: 'src/session.ts' });

    const issue = buildValidationFailedRecoveryIssue({
      task,
      createdAt,
      validationResults: [
        { stage: 'tsc', passed: true },
        { stage: 'test', passed: false, error: 'session.test.ts expected token refresh' },
      ],
      attempts: 2,
      maxAttempts: 3,
      selectedImplementerProfile: 'local-qwen',
    });

    expect(issue.reason).toBe('validation-failed');
    expect(issue.phase).toBe('validating-task');
    expect(issue.details[0]).toBe('Validation test failed: session.test.ts expected token refresh');
    expect(issue.facts).toMatchObject({
      validationStage: 'test',
      validationSummary: 'session.test.ts expected token refresh',
      canRetry: true,
    });
    expect(issue.availableActions).toEqual([
      'retry-same-worker',
      'planner-split-rebase',
      'skip-current-task',
      'pause-run',
      'abort-workflow',
    ]);
    expectValidRecoveryIssue(issue);
  });

  it('builds retry-exhausted issues without ordinary retry unless override is explicit', () => {
    const task = makeTask({ id: 'T012' });

    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'lint failed after all attempts',
      attempts: 3,
      maxAttempts: 3,
      routeBiggerProfile: 'agent-cli',
    });

    expect(issue.reason).toBe('retry-exhausted');
    expect(issue.phase).toBe('escalating');
    expect(issue.recommendedAction).toBe('route-bigger-worker');
    expect(issue.availableActions).toEqual([
      'route-bigger-worker',
      'planner-split-rebase',
      'skip-current-task',
      'pause-run',
      'abort-workflow',
    ]);
    expectValidRecoveryIssue(issue);

    const override = buildRetryExhaustedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'lint failed after all attempts',
      attempts: 3,
      maxAttempts: 3,
      allowRetryOverride: true,
    });
    expect(override.availableActions).toContain('retry-same-worker');
    expectValidRecoveryIssue(override);
  });

  it('builds context-overflow issues with route-bigger only when a larger worker is available', () => {
    const task = makeTask({ id: 'T013', file: 'src/large.ts' });
    const routingDecision = overflowRoutingDecision({ taskId: task.id });

    const withRoute = buildContextOverflowRecoveryIssue({
      task,
      createdAt,
      routingDecision,
      routeBiggerProfile: 'frontier-big',
    });

    expect(withRoute.reason).toBe('context-overflow');
    expect(withRoute.recommendedAction).toBe('route-bigger-worker');
    expect(withRoute.availableActions).toEqual([
      'route-bigger-worker',
      'planner-split-rebase',
      'pause-run',
      'abort-workflow',
    ]);
    expect(withRoute.facts).toMatchObject({
      estimatedTokens: 45_000,
      contextLength: 32_768,
      routeBiggerProfile: 'frontier-big',
    });
    expectValidRecoveryIssue(withRoute);

    const withoutRoute = buildContextOverflowRecoveryIssue({
      task,
      createdAt,
      routingDecision,
    });

    expect(withoutRoute.recommendedAction).toBe('planner-split-rebase');
    expect(withoutRoute.availableActions).toEqual([
      'planner-split-rebase',
      'pause-run',
      'abort-workflow',
    ]);
    expectValidRecoveryIssue(withoutRoute);

    const explicitlyUnavailableRoute = buildContextOverflowRecoveryIssue({
      task,
      createdAt,
      routingDecision,
      routeBiggerProfile: 'frontier-big',
      canRouteBigger: false,
    });

    expect(explicitlyUnavailableRoute.availableActions).toEqual([
      'planner-split-rebase',
      'pause-run',
      'abort-workflow',
    ]);
    expectValidRecoveryIssue(explicitlyUnavailableRoute);
  });

  it('builds blocking user-edit conflicts without unsafe continue', () => {
    const task = makeTask({ id: 'T014', file: 'src/current.ts' });
    const conflict = classifyUserEditConflict({
      files: ['src/current.ts'],
      currentTask: task,
      allTasks: [task],
      currentTaskIndex: 0,
    });

    const issue = buildUserEditConflictRecoveryIssue({
      conflict,
      currentTask: task,
      createdAt,
    });

    expect(issue.reason).toBe('user-edit-conflict');
    expect(issue.message).toBe('User edits conflict with T014');
    expect(issue.files).toEqual(['src/current.ts']);
    expect(issue.affectedTaskIds).toEqual([task.id]);
    expect(issue.availableActions).toEqual([
      'planner-split-rebase',
      'skip-current-task',
      'pause-run',
      'abort-workflow',
    ]);
    expect(issue.recommendedAction).toBe('planner-split-rebase');
    expectValidRecoveryIssue(issue);
  });

  it('builds safe user-edit conflicts with continue as the recommendation', () => {
    const task = makeTask({ id: 'T015', file: 'src/current.ts' });
    const conflict = classifyUserEditConflict({
      files: ['README.md'],
      currentTask: task,
      allTasks: [task],
      currentTaskIndex: 0,
    });

    const issue = buildUserEditConflictRecoveryIssue({
      conflict,
      currentTask: task,
      createdAt,
    });

    expect(issue.availableActions).toEqual(['continue', 'pause-run', 'abort-workflow']);
    expect(issue.recommendedAction).toBe('continue');
    expect(issue.facts).toMatchObject({ safeToContinue: true, conflictKind: 'unrelated' });
    expectValidRecoveryIssue(issue);
  });

  it('does not expose continue for malformed unsafe user-edit conflicts', () => {
    const task = makeTask({ id: 'T020', file: 'src/current.ts' });
    const conflict = classifyUserEditConflict({
      files: ['src/current.ts'],
      currentTask: task,
      allTasks: [task],
      currentTaskIndex: 0,
    });

    const issue = buildUserEditConflictRecoveryIssue({
      conflict: {
        ...conflict,
        safeToContinue: false,
        availableActions: ['continue-unrelated', 'pause', 'abort-workflow'],
      },
      currentTask: task,
      createdAt,
    });

    expect(issue.availableActions).toEqual(['pause-run', 'abort-workflow']);
    expect(issue.availableActions).not.toContain('continue');
    expectValidRecoveryIssue(issue);
  });

  it('builds approval-promotion conflicts without continue', () => {
    const task = makeTask({ id: 'T016', file: 'src/promote.ts' });
    const conflict = createApprovalPromotionConflict({
      files: ['src/promote.ts'],
      currentTaskId: task.id,
    });

    const issue = buildApprovalPromotionConflictRecoveryIssue({
      conflict,
      currentTask: task,
      createdAt,
    });

    expect(issue.reason).toBe('approval-promotion-conflict');
    expect(issue.message).toBe('Approval promotion blocked for T016');
    expect(issue.availableActions).toEqual([
      'planner-split-rebase',
      'skip-current-task',
      'pause-run',
      'abort-workflow',
    ]);
    expect(issue.availableActions).not.toContain('continue');
    expectValidRecoveryIssue(issue);
  });

  it('builds budget-paused issues with continue only below max budget', () => {
    const nextTask = makeTask({ id: 'T017', file: 'src/next.ts' });

    const belowMax = buildBudgetPausedRecoveryIssue({
      createdAt,
      currentCost: 4.25,
      maxBudget: 5,
      threshold: 0.85,
      nextTask,
      blockedStep: 'before T017',
    });

    expect(belowMax.reason).toBe('budget-paused');
    expect(belowMax.availableActions).toEqual(['continue', 'pause-run', 'abort-workflow']);
    expect(belowMax.facts).toMatchObject({ budgetPercent: 85, belowMaxBudget: true });
    expectValidRecoveryIssue(belowMax);

    const atMax = buildBudgetPausedRecoveryIssue({
      createdAt,
      currentCost: 5,
      maxBudget: 5,
      nextTask,
    });

    expect(atMax.availableActions).toEqual(['pause-run', 'abort-workflow']);
    expect(atMax.availableActions).not.toContain('continue');
    expectValidRecoveryIssue(atMax);
  });

  it('builds budget-exceeded issues without ordinary continue', () => {
    const issue = buildBudgetExceededRecoveryIssue({
      createdAt,
      currentCost: 5.25,
      maxBudget: 5,
      blockedStep: 'before final review',
    });

    expect(issue.reason).toBe('budget-exceeded');
    expect(issue.availableActions).toEqual(['pause-run', 'abort-workflow']);
    expect(issue.availableActions).not.toContain('continue');
    expect(issue.recommendedAction).toBe('pause-run');
    expect(issue.details).toContain('Continuing requires a separate raise-budget flow.');
    expectValidRecoveryIssue(issue);
  });

  it('builds dependency-blocked issues with affected tasks and safe actions', () => {
    const dependency = makeTask({ id: 'T018', file: 'src/base.ts', status: 'failed' });
    const task = makeTask({
      id: 'T019',
      file: 'src/followup.ts',
      dependsOn: ['T018'],
    });

    const issue = buildDependencyBlockedRecoveryIssue({
      createdAt,
      task,
      blockedByTasks: [dependency],
    });

    expect(issue.reason).toBe('dependency-blocked');
    expect(issue.files).toEqual(['src/base.ts', 'src/followup.ts']);
    expect(issue.affectedTaskIds).toEqual([dependency.id, task.id]);
    expect(issue.details).toEqual(['Blocked dependencies: T018 (failed)']);
    expect(issue.availableActions).toEqual([
      'planner-split-rebase',
      'skip-current-task',
      'pause-run',
      'abort-workflow',
    ]);
    expect(issue.recommendedAction).toBe('planner-split-rebase');
    expectValidRecoveryIssue(issue);
  });
});

describe('applyRecoveryAction', () => {
  it('continues only a safe budget pause and clears pending recovery', () => {
    const { projectDir, sessionId } = setupSession('continue-budget');
    const task = makeTask({ id: 'T030', file: 'src/next.ts' });
    const issue = buildBudgetPausedRecoveryIssue({
      createdAt,
      currentCost: 4.25,
      maxBudget: 5,
      threshold: 0.85,
      nextTask: task,
      blockedStep: 'before T030',
    });
    const state = { ...implementingState([task]), pendingRecovery: issue };
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'continue',
      bus,
      selectedAt,
    });

    expect(result).toMatchObject({ ok: true, status: 'continued' });
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toBeUndefined();
    expect(events.map(event => event.type)).toEqual(['recovery_action_selected', 'recovery_resolved']);
    expect(readSessionLog(projectDir, sessionId)).toContain('"type":"recovery_resolved"');
  });

  it('blocks ordinary continue for budget-exceeded even if an issue was malformed to advertise it', () => {
    const { projectDir, sessionId } = setupSession('continue-budget-exceeded');
    const issue = {
      ...buildBudgetExceededRecoveryIssue({
        createdAt,
        currentCost: 5.25,
        maxBudget: 5,
      }),
      availableActions: ['continue', 'pause-run', 'abort-workflow'] as ReturnType<typeof buildBudgetExceededRecoveryIssue>['availableActions'],
    };
    const state = { ...implementingState([makeTask({ id: 'T031' })]), pendingRecovery: issue };
    saveState(projectDir, sessionId, state);
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'continue',
      bus,
      selectedAt,
    });

    expect(result).toMatchObject({ ok: false, status: 'blocked', code: 'unsafe-continue' });
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toEqual(issue);
    expect(events.map(event => event.type)).toEqual(['recovery_action_selected', 'recovery_action_failed']);
    expect(state.pendingRecovery).toEqual(issue);
  });

  it('pauses with the recovery issue still pending and selected action persisted', () => {
    const { projectDir, sessionId } = setupSession('pause-run');
    const task = makeTask({ id: 'T032' });
    const issue = buildValidationFailedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'test failed',
      attempts: 2,
      maxAttempts: 3,
    });
    const state = { ...implementingState([task]), pendingRecovery: issue };
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'pause-run',
      bus,
      selectedAt,
    });

    expect(result).toMatchObject({ ok: true, status: 'paused' });
    expect(result.state.pendingRecovery).toMatchObject({
      id: issue.id,
      status: 'paused',
      selectedAction: 'pause-run',
      selectedAt,
    });
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toMatchObject({
      id: issue.id,
      status: 'paused',
      selectedAction: 'pause-run',
    });
    expect(events.map(event => event.type)).toEqual(['recovery_action_selected']);
  });

  it('aborts intentionally without mutating task status', () => {
    const { projectDir, sessionId } = setupSession('abort-workflow');
    const task = makeTask({ id: 'T033', status: 'in_progress' });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'all retries failed',
      attempts: 3,
      maxAttempts: 3,
    });
    const state = { ...implementingState([task]), pendingRecovery: issue };
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'abort-workflow',
      bus,
      selectedAt,
    });

    expect(result).toMatchObject({ ok: true, status: 'aborted' });
    expect(result.state.phase).toBe('idle');
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.tasks[0]?.status).toBe('in_progress');
    const persisted = loadState(projectDir, sessionId);
    expect(persisted?.phase).toBe('idle');
    expect(persisted?.pendingRecovery).toBeUndefined();
    expect(persisted?.tasks[0]).toMatchObject({ id: 'T033', status: 'in_progress' });
    expect(events.map(event => event.type)).toEqual(['recovery_action_selected', 'recovery_resolved']);
  });

  it('skips the current task, records evidence, clears recovery, and does not overwrite user edits', () => {
    const { projectDir, sessionId } = setupSession('skip-task');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const filePath = join(projectDir, 'src/user.ts');
    writeFileSync(filePath, 'export const owner = "user edit";\n');

    const task = makeTask({ id: 'T034', file: 'src/user.ts' });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'failed after retries',
      attempts: 3,
      maxAttempts: 3,
    });
    const state = { ...implementingState([task]), pendingRecovery: issue };
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'skip-current-task',
      bus,
      selectedAt,
    });

    expect(result).toMatchObject({ ok: true, status: 'skipped-current-task' });
    expect(readFileSync(filePath, 'utf-8')).toBe('export const owner = "user edit";\n');
    expect(result.state.currentTaskIndex).toBe(1);
    expect(result.state.tasks[0]?.status).toBe('skipped');
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toBeUndefined();
    expect(readEvidenceLedger(projectDir, sessionId)?.tasks[0]?.observedEvidence).toContain(
      'skipped: recovery retry-exhausted: T034 exhausted recovery retries',
    );
    expect(events.map(event => event.type)).toEqual([
      'recovery_action_selected',
      'task_skipped',
      'recovery_resolved',
    ]);
  });

  it('prepares retry-same-worker by resetting only the current task without advancing', () => {
    const { projectDir, sessionId } = setupSession('retry-same-worker');
    const task = makeTask({ id: 'T035', status: 'in_progress' });
    const issue = buildValidationFailedRecoveryIssue({
      task,
      createdAt,
      validationSummary: 'lint failed',
      attempts: 1,
      maxAttempts: 3,
      selectedImplementerProfile: 'local-qwen',
    });
    const state = {
      ...implementingState([task]),
      attempt: 2,
      pendingRecovery: issue,
    };
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'retry-same-worker',
      bus,
      selectedAt,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'retry-current-task',
      implementerProfile: 'local-qwen',
    });
    expect(result.state.currentTaskIndex).toBe(0);
    expect(result.state.attempt).toBe(0);
    expect(result.state.tasks[0]?.status).toBe('pending');
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(loadState(projectDir, sessionId)?.tasks[0]?.status).toBe('pending');
    expect(events.map(event => event.type)).toEqual(['recovery_action_selected', 'recovery_resolved']);
  });

  it('blocks route-bigger-worker without silently clearing recovery or rerunning', () => {
    const { projectDir, sessionId } = setupSession('route-bigger-blocked');
    const task = makeTask({ id: 'T036', file: 'src/large.ts' });
    const issue = buildContextOverflowRecoveryIssue({
      task,
      createdAt,
      routingDecision: overflowRoutingDecision({ taskId: task.id }),
      routeBiggerProfile: 'cheap-cloud',
    });
    const state = { ...implementingState([task]), pendingRecovery: issue };
    saveState(projectDir, sessionId, state);
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'route-bigger-worker',
      bus,
      selectedAt,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      code: 'route-bigger-not-ready',
      implementerProfile: 'cheap-cloud',
    });
    expect(result.state.pendingRecovery).toEqual(issue);
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toEqual(issue);
    expect(events.map(event => event.type)).toEqual(['recovery_action_selected', 'recovery_action_failed']);
  });

  it('blocks planner-split-rebase until a proposal approval flow exists', () => {
    const { projectDir, sessionId } = setupSession('planner-proposal-required');
    const task = makeTask({ id: 'T037' });
    const issue = buildDependencyBlockedRecoveryIssue({
      task,
      createdAt,
      blockedByTaskIds: ['T001' as Task['id']],
    });
    const state = { ...implementingState([task]), pendingRecovery: issue };
    saveState(projectDir, sessionId, state);
    const { bus, events } = makeBus(projectDir, sessionId);

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'planner-split-rebase',
      bus,
      selectedAt,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      code: 'planner-proposal-required',
    });
    expect(result.state.pendingRecovery).toEqual(issue);
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toEqual(issue);
    expect(events.map(event => event.type)).toEqual(['recovery_action_selected', 'recovery_action_failed']);
  });
});
