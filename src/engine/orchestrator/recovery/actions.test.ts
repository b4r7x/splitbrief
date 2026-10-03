import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import type { Config } from '../../../core/schemas/config.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { Task } from '../../../core/schemas/task.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { applyRecoveryAction } from './actions.js';
import { buildDependencyBlockedRecoveryIssue } from './builders/task.js';
import { buildUserEditConflictRecoveryIssue } from './builders/workflow.js';
import { classifyUserEditConflict } from '../user-edit/conflicts.js';

const createdAt = '2026-04-28T12:00:00.000Z';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupSession(name: string): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  const sessionId = `sess-${name}`;
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function routeBiggerIssue(task: Task, facts?: RecoveryIssue['facts']): RecoveryIssue {
  return {
    id: `rec_${task.id}_route_bigger`,
    reason: 'context-overflow',
    phase: 'implementing',
    status: 'awaiting-user',
    taskId: task.id,
    taskTitle: task.title,
    files: [task.file],
    affectedTaskIds: [task.id],
    message: `${task.id} needs a larger worker`,
    details: [],
    ...(facts !== undefined ? { facts } : {}),
    availableActions: ['route-bigger-worker'],
    recommendedAction: 'route-bigger-worker',
    createdAt,
  };
}

function configWithProfiles(): Config {
  const implementerProfiles: NonNullable<Config['implementerProfiles']> = {
    default: 'local-fast',
    profiles: {
      'cloud-capable': {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'claude-sonnet',
      },
      'local-fast': {
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen2.5-coder:7b',
      },
    },
  };
  return { ...makeConfig(), implementerProfiles };
}

describe('applyRecoveryAction: reason policy', () => {
  it('blocks actions that violate the reason policy even when advertised in state', () => {
    const { projectDir, sessionId } = setupSession('policy-block');
    const task = makeTask({ id: 'T200', status: 'in_progress' });
    const issue: RecoveryIssue = {
      id: 'rec_review_skip',
      reason: 'review-failed',
      phase: 'implementing',
      status: 'awaiting-user',
      taskId: task.id,
      taskTitle: task.title,
      files: [task.file],
      affectedTaskIds: [task.id],
      message: 'Review failed',
      details: [],
      availableActions: ['skip-current-task', 'pause-run', 'end-run'],
      recommendedAction: 'pause-run',
      createdAt,
    };
    const state = { ...makeImplState([task]), pendingRecovery: issue };
    const { bus } = makeBusRecorder();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'skip-current-task',
      bus,
      config: makeConfig(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('action-not-available');
    expect(result.message).toContain('not allowed');
  });
});

describe('applyRecoveryAction: route-bigger-worker blocked', () => {
  it('blocks when the recovery issue does not name a bigger profile', () => {
    const { projectDir, sessionId } = setupSession('route-bigger-missing-fact');
    const task = makeTask({ id: 'T101', status: 'in_progress' });
    const issue = routeBiggerIssue(task, {});
    const state = { ...makeImplState([task]), pendingRecovery: issue };
    const { bus } = makeBusRecorder();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'route-bigger-worker',
      bus,
      config: configWithProfiles(),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      code: 'missing-profile',
    });
    expect(issue.selectedImplementerProfile).toBeUndefined();
    expect(result.state.pendingRecovery).toBe(issue);
  });

  it('blocks when the named bigger profile is not in config', () => {
    const { projectDir, sessionId } = setupSession('route-bigger-unknown-profile');
    const task = makeTask({ id: 'T102', status: 'in_progress' });
    const issue = routeBiggerIssue(task, { routeBiggerProfile: 'frontier-big' });
    const state = { ...makeImplState([task]), pendingRecovery: issue };
    const { bus } = makeBusRecorder();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'route-bigger-worker',
      bus,
      config: configWithProfiles(),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      code: 'profile-not-found',
      implementerProfile: 'frontier-big',
    });
    expect(result.state.pendingRecovery).toBe(issue);
  });

  it('blocks when config is undefined', () => {
    const { projectDir, sessionId } = setupSession('route-bigger-no-config');
    const task = makeTask({ id: 'T103', status: 'in_progress' });
    const issue = routeBiggerIssue(task, { routeBiggerProfile: 'cloud-capable' });
    const state = { ...makeImplState([task]), pendingRecovery: issue };
    const { bus } = makeBusRecorder();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'route-bigger-worker',
      bus,
      config: undefined,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      code: 'profile-not-found',
    });
  });
});

describe('applyRecoveryAction: unsafe continue blocked', () => {
  it('blocks ordinary continue for an unsafe conflict even if an issue was malformed to advertise it', () => {
    const { projectDir, sessionId } = setupSession('continue-unsafe-conflict');
    const conflictTask = makeTask({ id: 'T031', file: 'src/current.ts' });
    const persistedIssue = buildUserEditConflictRecoveryIssue({
      createdAt,
      currentTask: conflictTask,
      conflict: classifyUserEditConflict({
        files: ['src/current.ts'],
        currentTask: conflictTask,
        currentTaskInFlight: true,
        allTasks: [conflictTask],
        currentTaskIndex: 0,
      }),
    });
    const issue = {
      ...persistedIssue,
      availableActions: ['continue', 'pause-run', 'end-run'] as ReturnType<
        typeof buildUserEditConflictRecoveryIssue
      >['availableActions'],
    };
    const base = makeImplState([makeTask({ id: 'T031' })]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: persistedIssue });
    const state = { ...base, pendingRecovery: issue };
    const { bus, events } = makeBusRecorder();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'continue',
      bus,
    });

    expect(result).toMatchObject({ ok: false, status: 'blocked', code: 'unsafe-continue' });
    expect(result.state.pendingRecovery).toEqual(issue);
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toEqual(persistedIssue);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'recovery_action_failed']),
    );
    expect(state.pendingRecovery).toEqual(issue);
  });
});

describe('applyRecoveryAction: the run-level answers', () => {
  function plannerHaltState(projectDir: string, sessionId: string, issue: RecoveryIssue) {
    const base = makeImplState([makeTask({ id: 'T001' })]);
    const state = { ...base, pendingRecovery: issue };
    saveState({ projectDir, sessionId }, state);
    const saved = loadState({ projectDir, sessionId });
    if (saved === null) throw new Error('expected the halt to persist');
    return saved;
  }

  function reviseIssue(reason: RecoveryIssue['reason']): RecoveryIssue {
    return {
      id: `rec_${reason}`,
      reason,
      phase: 'reviewing-briefs',
      status: 'awaiting-user',
      files: [],
      affectedTaskIds: [],
      message: 'the planner needs a correction',
      details: [],
      availableActions:
        reason === 'constitution-check-failed' ? ['revise-spec', 'end-run'] : ['revise', 'end-run'],
      recommendedAction: reason === 'constitution-check-failed' ? 'revise-spec' : 'revise',
      createdAt,
    };
  }

  it('revise queues the comment and clears the halt', () => {
    const { projectDir, sessionId } = setupSession('recovery-revise');
    const state = plannerHaltState(projectDir, sessionId, reviseIssue('brief-review-no-progress'));
    const { bus, events } = makeBusRecorder();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'revise',
      bus,
      comment: '  split the first brief  ',
    });

    expect(result).toMatchObject({ ok: true, status: 'continued' });
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.messageQueue.map((message) => message.text)).toEqual([
      'split the first brief',
    ]);
    expect(loadState({ projectDir, sessionId })?.messageQueue).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'recovery_resolved']),
    );
  });

  it('revise with no comment still resolves the halt and queues nothing', () => {
    const { projectDir, sessionId } = setupSession('recovery-revise-empty');
    const state = plannerHaltState(projectDir, sessionId, reviseIssue('brief-review-no-progress'));
    const { bus } = makeBusRecorder();

    const result = applyRecoveryAction({ projectDir, sessionId, state, action: 'revise', bus });

    expect(result).toMatchObject({ ok: true, status: 'continued' });
    expect(result.state.messageQueue).toHaveLength(0);
    expect(result.state.pendingRecovery).toBeUndefined();
  });

  // No spec step is left to rewind to: an old run's constitution halt sends its note to the one
  // planning session as a queued correction.
  it('revise-spec on an old constitution halt queues the note and clears the halt', () => {
    const { projectDir, sessionId } = setupSession('recovery-revise-spec');
    const issue = {
      ...reviseIssue('constitution-check-failed'),
      phase: 'constitution-check' as const,
    };
    const state = plannerHaltState(projectDir, sessionId, issue);
    const { bus } = makeBusRecorder();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'revise-spec',
      bus,
      comment: 'drop the class',
    });

    expect(result).toMatchObject({ ok: true, status: 'continued' });
    expect(result.state.rewindPending).toBeUndefined();
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.messageQueue.map((message) => message.text)).toEqual(['drop the class']);
    expect(loadState({ projectDir, sessionId })?.messageQueue).toHaveLength(1);
  });

  it('switch-seat on a plan-seat halt resolves it without resetting a brief', () => {
    const { projectDir, sessionId } = setupSession('recovery-plan-seat-swap');
    const issue: RecoveryIssue = {
      id: 'rec_planner_call_failed',
      reason: 'planner-call-failed',
      phase: 'planning',
      status: 'awaiting-user',
      seat: 'plan',
      files: [],
      affectedTaskIds: [],
      message: 'Planning failed.',
      details: [],
      switchSeat: { seat: 'plan', candidates: [{ tool: 'claude-code' }] },
      availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
      recommendedAction: 'switch-seat',
      createdAt,
    };
    const state = plannerHaltState(projectDir, sessionId, issue);
    const { bus } = makeBusRecorder();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'switch-seat',
      bus,
      config: makeConfig(),
    });

    expect(result).toMatchObject({ ok: true, status: 'continued' });
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.tasks[0]?.status).toBe(state.tasks[0]?.status);
  });

  it('end-run closes the run and refuses every later transition', () => {
    const { projectDir, sessionId } = setupSession('recovery-end-run');
    const state = plannerHaltState(projectDir, sessionId, reviseIssue('brief-review-no-progress'));
    const { bus } = makeBusRecorder();

    const result = applyRecoveryAction({ projectDir, sessionId, state, action: 'end-run', bus });

    expect(result).toMatchObject({ ok: true, status: 'closed' });
    expect(result.state.closed?.as).toBe('ended');
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.closed?.as).toBe('ended');
  });
});

describe('applyRecoveryAction: planner-split-rebase blocked', () => {
  it('blocks planner-split-rebase until a proposal approval flow exists', () => {
    const { projectDir, sessionId } = setupSession('planner-proposal-required');
    const task = makeTask({ id: 'T037' });
    const persistedIssue = buildDependencyBlockedRecoveryIssue({
      task,
      createdAt,
      blockedByTaskIds: ['T001' as Task['id']],
    });
    const issue = {
      ...persistedIssue,
      availableActions: ['planner-split-rebase', 'pause-run', 'end-run'],
      recommendedAction: 'planner-split-rebase',
    } satisfies ReturnType<typeof buildDependencyBlockedRecoveryIssue>;
    const base = makeImplState([task]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: persistedIssue });
    const state = { ...base, pendingRecovery: issue };
    const { bus, events } = makeBusRecorder();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'planner-split-rebase',
      bus,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      code: 'planner-proposal-required',
    });
    expect(result.state.pendingRecovery).toEqual(issue);
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toEqual(persistedIssue);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'recovery_action_failed']),
    );
  });
});

function usageLimitIssue(task: Task): RecoveryIssue {
  return {
    id: `rec_${task.id}_usage_limit`,
    reason: 'runner-usage-limit',
    phase: 'implementing',
    status: 'awaiting-user',
    taskId: task.id,
    taskTitle: task.title,
    files: [task.file],
    affectedTaskIds: [task.id],
    message: 'Codex hit its usage limit.',
    details: [],
    switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }, { tool: 'opencode' }] },
    availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
    recommendedAction: 'switch-seat',
    createdAt,
  };
}

describe('applyRecoveryAction: switch-seat', () => {
  it('resets the task onto the chosen tool and returns the switched config', () => {
    const { projectDir, sessionId } = setupSession('switch-seat-apply');
    const task = makeTask({ id: 'T400', status: 'in_progress' });
    const issue = usageLimitIssue(task);
    const base = makeImplState([task]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: issue });
    const state = { ...base, pendingRecovery: issue };
    const { bus, events } = makeBusRecorder();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'switch-seat',
      bus,
      config: makeConfig(),
      candidate: { tool: 'opencode' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('retry-current-task');
    expect(result.action).toBe('switch-seat');
    expect(result.switchedSeat).toEqual({ seat: 'build', candidate: { tool: 'opencode' } });
    expect(result.switchedConfig?.implementer).toMatchObject({ kind: 'cli', tool: 'opencode' });
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['recovery_action_selected', 'task_reset', 'recovery_resolved']),
    );
  });

  it('takes the first offered tool when no candidate is named', () => {
    const { projectDir, sessionId } = setupSession('switch-seat-default');
    const task = makeTask({ id: 'T401', status: 'in_progress' });
    const issue = usageLimitIssue(task);
    const base = makeImplState([task]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: issue });
    const { bus } = makeBusRecorder();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state: { ...base, pendingRecovery: issue },
      action: 'switch-seat',
      bus,
      config: makeConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.switchedSeat?.candidate).toEqual({ tool: 'claude-code' });
  });

  it('blocks a tool the issue never offered', () => {
    const { projectDir, sessionId } = setupSession('switch-seat-not-offered');
    const task = makeTask({ id: 'T402', status: 'in_progress' });
    const issue = usageLimitIssue(task);
    const base = makeImplState([task]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: issue });
    const { bus } = makeBusRecorder();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state: { ...base, pendingRecovery: issue },
      action: 'switch-seat',
      bus,
      config: makeConfig(),
      candidate: { tool: 'cursor' },
    });

    expect(result).toMatchObject({ ok: false, code: 'candidate-not-offered' });
  });

  it('blocks when the halt carried no seat-swap offer', () => {
    const { projectDir, sessionId } = setupSession('switch-seat-no-offer');
    const task = makeTask({ id: 'T403', status: 'in_progress' });
    const { switchSeat: _offer, ...withoutOffer } = usageLimitIssue(task);
    const base = makeImplState([task]);
    saveState({ projectDir, sessionId }, { ...base, pendingRecovery: withoutOffer });
    const { bus } = makeBusRecorder();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state: { ...base, pendingRecovery: withoutOffer },
      action: 'switch-seat',
      bus,
      config: makeConfig(),
    });

    expect(result).toMatchObject({ ok: false, code: 'seat-swap-unavailable' });
  });
});

it('records CLI recovery evidence with no workflow mode, even for a run that saved one', () => {
  const ref = setupSession('skip-saved-mode');
  const state = makeImplState([makeTask({ status: 'failed' })], {
    mode: 'speckit',
    pendingRecovery: makeRecoveryIssue(),
  });
  saveState(ref, state);
  const { bus } = makeBusRecorder();
  const result = applyRecoveryAction({ ...ref, state, action: 'skip-current-task', bus });
  expect(result.ok).toBe(true);
  expect(readEvidenceLedger(ref)).not.toHaveProperty('mode');
});
