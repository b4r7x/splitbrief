import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QueuedMessage, WorkflowState } from '../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { createEventBus } from '../events/bus.js';
import type { EngineEvent } from '../events/types.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import {
  transitionAndSave,
  raisePendingRecovery,
  rebaseOnPersistedWorkflowState,
  addUsageAndSave,
} from './state-ops.js';
import { refreshAndPersistCode } from './task/refresh-code.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('state-ops-test');
  const sessionId = 'sess-state-ops';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function makeState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    stateVersion: 1,
    phase: 'implementing',
    feature: 'test',
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    plannerSessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: makeUsage(),
    awaitingContinue: false,
    messageQueue: [],
    ...overrides,
  };
}

function makeQueuedMessage(): QueuedMessage {
  return {
    id: 'msg-one',
    text: 'queued while planner was running',
    queuedAt: '2026-05-27T04:00:00.000Z',
    phase: 'researching',
    deliveredViaNative: false,
    nativeDeliveryState: 'pending',
  };
}

describe('addUsageAndSave', () => {
  it('accumulates token usage into the new state and emits a cost-update event', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      const state = makeState({ tokenUsage: makeUsage({ plannerInput: 100, plannerOutput: 50 }) });
      const { bus, events } = makeBusRecorder();

      const result = addUsageAndSave({ projectDir, sessionId, bus }, state, 'planner', {
        inputTokens: 200,
        outputTokens: 100,
      });

      expect(result.tokenUsage.plannerInput).toBe(300);
      expect(result.tokenUsage.plannerOutput).toBe(150);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'cost_update' });
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('returns the same state instance and emits nothing when usage is null', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      const state = makeState();
      const { bus, events } = makeBusRecorder();

      const result = addUsageAndSave({ projectDir, sessionId, bus }, state, 'implementer', null);

      expect(result).toBe(state);
      expect(events).toHaveLength(0);
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('rebases interleaved planner bookings on the latest ledger and workflow fields while merging queues', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      const ref = { projectDir, sessionId };
      const { bus } = makeBusRecorder();
      const firstMessage = makeQueuedMessage();
      const secondMessage = { ...firstMessage, id: 'msg-two', text: 'another queued message' };
      const persisted = transition(createInitialState('feature'), { type: 'START' });
      saveState(ref, persisted);

      const stale = { ...persisted, messageQueue: [firstMessage, secondMessage] };
      addUsageAndSave({ ...ref, bus }, stale, 'planner', {
        inputTokens: 100,
        outputTokens: 25,
      });

      const afterFirst = loadState(ref);
      if (!afterFirst) throw new Error('expected first usage booking to persist');
      saveState(ref, { ...afterFirst, phase: 'planning', plannerSessionId: 'latest-planner' });

      const result = addUsageAndSave({ ...ref, bus }, stale, 'planner', {
        inputTokens: 200,
        outputTokens: 50,
      });
      const saved = loadState(ref);

      expect(result.tokenUsage.plannerInput).toBe(300);
      expect(result.tokenUsage.plannerOutput).toBe(75);
      expect(result.phase).toBe('planning');
      expect(result.plannerSessionId).toBe('latest-planner');
      expect(result.messageQueue.map((message) => message.id)).toEqual(['msg-one', 'msg-two']);
      expect(saved?.tokenUsage).toMatchObject({ plannerInput: 300, plannerOutput: 75 });
      expect(saved?.phase).toBe('planning');
      expect(saved?.plannerSessionId).toBe('latest-planner');
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});

describe('rebaseOnPersistedWorkflowState', () => {
  it('prefers persisted rewindPending and phase over stale in-memory state', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      let staleState = createInitialState('feature');
      staleState = transition(staleState, { type: 'START' });
      saveState({ projectDir, sessionId }, staleState);

      staleState = transition(staleState, {
        type: 'ENQUEUE_USER_MSG',
        message: makeQueuedMessage(),
      });
      saveState(
        { projectDir, sessionId },
        transition(staleState, {
          type: 'REWIND_TO_PLAN',
          comment: 'revise the approach',
        }),
      );

      const rebased = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, staleState);

      expect(rebased.phase).toBe('planning');
      expect(rebased.rewindPending).toEqual({ target: 'plan', comment: 'revise the approach' });
      expect(rebased.messageQueue).toEqual([expect.objectContaining({ id: 'msg-one' })]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});

describe('transitionAndSave', () => {
  it('applies transitions to the latest persisted state so queued messages are not lost', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      let staleState = createInitialState('feature');
      staleState = transition(staleState, { type: 'START' });
      saveState({ projectDir, sessionId }, { ...staleState, messageQueue: [makeQueuedMessage()] });

      const next = transitionAndSave({ projectDir, sessionId }, staleState, {
        type: 'RESEARCH_DONE',
      });

      expect(next.phase).toBe('specifying');
      expect(next.messageQueue).toEqual([expect.objectContaining({ id: 'msg-one' })]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});

describe('raisePendingRecovery', () => {
  it('persists the issue, publishes recovery_prompted, and notifies setTrackedState', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      const bus = createEventBus();
      const events: EngineEvent[] = [];
      bus.subscribe((event) => events.push(event));
      const issue = makeRecoveryIssue();
      const state = createInitialState('feature');
      let tracked: WorkflowState | undefined;

      const next = raisePendingRecovery({ projectDir, sessionId, bus }, state, issue, (s) => {
        tracked = s;
      });

      expect(next.pendingRecovery).toEqual(issue);
      expect(loadState({ projectDir, sessionId })?.pendingRecovery).toEqual(issue);
      expect(tracked).toBe(next);
      const prompted = events.find((event) => event.type === 'recovery_prompted');
      expect(prompted).toMatchObject({ issueId: issue.id, reason: issue.reason });
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('still persists and publishes when no setTrackedState is given', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      const bus = createEventBus();
      const events: EngineEvent[] = [];
      bus.subscribe((event) => events.push(event));
      const issue = makeRecoveryIssue({ id: 'rec_2026_04_28_002' });
      const state = createInitialState('feature');

      const next = raisePendingRecovery({ projectDir, sessionId, bus }, state, issue);

      expect(next.pendingRecovery).toEqual(issue);
      expect(loadState({ projectDir, sessionId })?.pendingRecovery).toEqual(issue);
      expect(events.some((event) => event.type === 'recovery_prompted')).toBe(true);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});

describe('refreshAndPersistCode', () => {
  itUnix('clears currentCode when the task file is a symlink escape', async () => {
    const projectDir = createTempDir('state-ops-symlink');
    const outside = createTempDir('state-ops-symlink-outside');
    const sessionId = 'sess-state-ops';
    ensureSessionDir(projectDir, sessionId);
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(outside, 'secret.ts'), 'outside');
      symlinkSync(join(outside, 'secret.ts'), join(projectDir, 'src', 'leak.ts'));

      const task = makeTask({ file: 'src/leak.ts' });
      const state = createInitialState('feature');

      const result = await refreshAndPersistCode(task, { projectDir, sessionId }, state);

      expect(result.task.currentCode).toBeUndefined();
      expect(readFileSync(join(outside, 'secret.ts'), 'utf-8')).toBe('outside');
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(projectDir);
    }
  });
});
