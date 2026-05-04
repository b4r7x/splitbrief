import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import type { Config } from '../../../core/schemas/config.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { createEventBus } from '../../events/bus.js';
import type { EngineEvent, EventBus } from '../../events/types.js';
import { applyRecoveryAction } from './actions.js';

const createdAt = '2026-04-28T12:00:00.000Z';
const selectedAt = '2026-04-28T12:05:00.000Z';

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

function makeBus(): { bus: EventBus; events: EngineEvent[] } {
  const bus = createEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe(event => events.push(event));
  return { bus, events };
}

function implementingState(tasks: Task[]): WorkflowState {
  let state = createInitialState('feat');
  state = transition(state, { type: 'START', feature: 'feat' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks });
  return transition(state, { type: 'APPROVE_PLAN' });
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
        provider: 'anthropic',
        apiBase: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet',
        costTier: 'standard',
      },
      'local-fast': {
        kind: 'api',
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen2.5-coder:7b',
        costTier: 'local',
      },
    },
  };
  return { ...makeConfig(), implementerProfiles };
}

describe('applyRecoveryAction: route-bigger-worker', () => {
  it('retries the current task with the bigger profile when it exists', () => {
    const { projectDir, sessionId } = setupSession('route-bigger-success');
    const task = makeTask({ id: 'T100', status: 'in_progress' });
    const issue = routeBiggerIssue(task, { routeBiggerProfile: 'cloud-capable' });
    const state = { ...implementingState([task]), attempt: 2, pendingRecovery: issue };
    const { bus, events } = makeBus();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'route-bigger-worker',
      bus,
      config: configWithProfiles(),
      selectedAt,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'retry-current-task',
      implementerProfile: 'cloud-capable',
    });
    expect(result.state).toMatchObject({
      currentTaskIndex: 0,
      attempt: 0,
      pendingRecovery: undefined,
    });
    expect(result.state.tasks[0]).toMatchObject({ id: task.id, status: 'pending' });
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toBeUndefined();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'recovery_resolved',
        action: 'route-bigger-worker',
        outcome: 'retry-current-task',
        implementerProfile: 'cloud-capable',
      }),
    ]));
  });

  it('blocks when the recovery issue does not name a bigger profile', () => {
    const { projectDir, sessionId } = setupSession('route-bigger-missing-fact');
    const task = makeTask({ id: 'T101', status: 'in_progress' });
    const issue = routeBiggerIssue(task, {});
    const state = { ...implementingState([task]), pendingRecovery: issue };
    const { bus } = makeBus();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'route-bigger-worker',
      bus,
      config: configWithProfiles(),
      selectedAt,
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
    const state = { ...implementingState([task]), pendingRecovery: issue };
    const { bus } = makeBus();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'route-bigger-worker',
      bus,
      config: configWithProfiles(),
      selectedAt,
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
    const state = { ...implementingState([task]), pendingRecovery: issue };
    const { bus } = makeBus();

    const result = applyRecoveryAction({
      projectDir,
      sessionId,
      state,
      action: 'route-bigger-worker',
      bus,
      config: undefined,
      selectedAt,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      code: 'profile-not-found',
    });
  });
});
