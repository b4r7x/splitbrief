import { plainUserMessage } from '../../core/types/user-input.js';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { QueuedMessage, WorkflowState } from '../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { createEventBus } from '../events/bus.js';
import type { EngineEvent } from '../events/types.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { formatRecoveryHeadline } from '../../core/recovery/headline.js';
import { formatResumeCommand } from '../../core/recovery/resume-command.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeLegacyV3State } from '#testing/helpers/factories/workflow-state.js';
import { createHash } from 'node:crypto';
import { deriveRunStatus } from '../../core/sessions/run-status.js';
import { clearPendingQueue } from './queue/clear.js';
import { enqueueUserMessage } from './queue/submit.js';
import { dispatchNativeInjection } from './queue/native-injection.js';
import { readQueueForPrompt, releaseQueuedMessage } from './queue/drain.js';
import { isQueuedMessagePendingDelivery } from '../../core/queue-state.js';
import { sessionDir } from '../../core/paths.js';
import { resumeStep } from '../../core/sessions/run-status.js';
import {
  stateOpsError,
  transitionAndSave,
  parkStoppedRun,
  raisePendingRecovery,
  rebaseOnPersistedWorkflowState,
  addUsageAndSave,
  recordResumeUserMessage,
  readWorkflowStateHead,
} from './state-ops.js';

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
    ...plainUserMessage('queued while planner was running'),
    queuedAt: '2026-05-27T04:00:00.000Z',
    phase: 'researching',
    deliveredViaNative: false,
    nativeDeliveryState: 'pending',
  };
}

describe('recordResumeUserMessage', () => {
  it('stores only expanded attachment messages, including after the first attachment', () => {
    const ref = setupProject();
    try {
      saveState(ref, createInitialState('feature'));
      const ts = '2026-10-10T00:00:00.000Z';
      const message = {
        ts,
        phase: 'planning' as const,
        displayText: 'Use @notes.md',
        text: 'Use @notes.md\n\nPELICAN-42 \n',
      };
      recordResumeUserMessage(ref, message);
      recordResumeUserMessage(ref, {
        ts,
        phase: 'planning',
        ...plainUserMessage('plain follow-up'),
      });
      expect(loadState(ref)?.resumeUserMessages).toEqual([message]);
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });
});

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
  it.each([false, true])('preserves a persisted clear with keepUnsaved=%s', (keepUnsaved) => {
    const ref = setupProject();
    try {
      const { bus } = makeBusRecorder();
      const stale = transitionAndSave(ref, createInitialState('feature'), {
        type: 'ENQUEUE_USER_MSG',
        message: makeQueuedMessage(),
      });
      clearPendingQueue({ ...ref, state: stale, bus });

      const rebased = rebaseOnPersistedWorkflowState(ref, stale, { keepUnsaved });

      expect(rebased.messageQueue).toEqual([]);
      expect(loadState(ref)?.messageQueue).toEqual([]);
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });

  it('keeps an enqueue that has not been saved at the current revision', () => {
    const ref = setupProject();
    try {
      const saved = transitionAndSave(ref, createInitialState('feature'), { type: 'START' });
      const unsaved = transition(saved, {
        type: 'ENQUEUE_USER_MSG',
        message: makeQueuedMessage(),
      });

      const rebased = rebaseOnPersistedWorkflowState(ref, unsaved, { keepUnsaved: true });

      expect(rebased.messageQueue).toEqual([makeQueuedMessage()]);
      expect(loadState(ref)?.messageQueue).toEqual([]);
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });

  it('keeps persisted delivery markers when the caller still holds a pending message', () => {
    const ref = setupProject();
    try {
      const stale = transitionAndSave(ref, createInitialState('feature'), {
        type: 'ENQUEUE_USER_MSG',
        message: makeQueuedMessage(),
      });
      const drained = transitionAndSave(ref, stale, { type: 'DRAIN_QUEUE' });

      const rebased = rebaseOnPersistedWorkflowState(ref, stale, { keepUnsaved: true });

      expect(rebased.messageQueue).toEqual(drained.messageQueue);
      expect(rebased.messageQueue.some(isQueuedMessagePendingDelivery)).toBe(false);
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });

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
        transition(
          { ...staleState, phase: 'reviewing-plan' },
          { type: 'CORRECT_PLAN', comment: 'revise the approach' },
        ),
      );

      const rebased = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, staleState);

      expect(rebased.phase).toBe('reviewing-plan');
      expect(rebased.rewindPending).toEqual({ target: 'plan', comment: 'revise the approach' });
      expect(rebased.messageQueue).toEqual([expect.objectContaining({ id: 'msg-one' })]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});

describe('a state write that fails', () => {
  it('names state.json and the cause in plain words', () => {
    const ref = setupProject();
    const dir = sessionDir(ref.projectDir, ref.sessionId);
    const saved = transitionAndSave(ref, createInitialState('feature'), { type: 'START' });
    chmodSync(dir, 0o555);
    try {
      expect(() =>
        transitionAndSave(ref, saved, {
          type: 'INTERRUPT_STEP',
          step: resumeStep(saved),
          source: 'user',
          cut: 'mid-step',
        }),
      ).toThrow(
        'Could not save the run state: permission denied · .splitbrief/sessions/sess-state-ops/state.json',
      );
    } finally {
      chmodSync(dir, 0o755);
      cleanupTempDir(ref.projectDir);
    }
  });

  it('names state.json in plain words when it cannot read it before the write', () => {
    const ref = setupProject();
    const saved = transitionAndSave(ref, createInitialState('feature'), { type: 'START' });
    writeFileSync(join(sessionDir(ref.projectDir, ref.sessionId), 'state.json'), '{"tru');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() =>
        transitionAndSave(ref, saved, {
          type: 'INTERRUPT_STEP',
          step: resumeStep(saved),
          source: 'user',
          cut: 'mid-step',
        }),
      ).toThrow(
        'Could not read the run state: it could not be read, or its content is not valid · .splitbrief/sessions/sess-state-ops/state.json',
      );
    } finally {
      stderr.mockRestore();
      cleanupTempDir(ref.projectDir);
    }
  });

  it('says in plain words when a written state cannot be confirmed', () => {
    const { message } = stateOpsError.durabilityUncertain('sess-state-ops');
    expect(message).toBe(
      'Saved the run state, but could not confirm it on disk · .splitbrief/sessions/sess-state-ops/state.json',
    );
  });
});

describe('transitionAndSave', () => {
  it.each(['transition', 'queue', 'usage'] as const)(
    'does not persist a cleared message through a stale %s writer',
    (writer) => {
      const ref = setupProject();
      try {
        const { bus } = makeBusRecorder();
        const stale = transitionAndSave(ref, createInitialState('feature'), {
          type: 'ENQUEUE_USER_MSG',
          message: makeQueuedMessage(),
        });
        const cleared = clearPendingQueue({ ...ref, state: stale, bus }).state;
        const next =
          writer === 'usage'
            ? addUsageAndSave({ ...ref, bus }, stale, 'implementer', {
                inputTokens: 1,
                outputTokens: 1,
              })
            : writer === 'queue'
              ? transitionAndSave(
                  ref,
                  stale,
                  { type: 'MARK_INJECTING_NATIVE', id: makeQueuedMessage().id },
                  { expectedRevision: cleared.stateRevision },
                )
              : transitionAndSave(ref, stale, { type: 'START' });

        expect(next.messageQueue).toEqual([]);
        expect(loadState(ref)?.messageQueue).toEqual([]);
      } finally {
        cleanupTempDir(ref.projectDir);
      }
    },
  );

  it('saves an enqueue that the caller has not saved yet', () => {
    const ref = setupProject();
    try {
      const saved = transitionAndSave(ref, createInitialState('feature'), { type: 'START' });
      const unsaved = transition(saved, {
        type: 'ENQUEUE_USER_MSG',
        message: makeQueuedMessage(),
      });

      const next = transitionAndSave(ref, unsaved, { type: 'PLAN_DONE', tasks: [] });

      expect(next.messageQueue).toEqual([makeQueuedMessage()]);
      expect(loadState(ref)?.messageQueue).toEqual([makeQueuedMessage()]);
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });

  it('applies transitions to the latest persisted state so queued messages are not lost', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      let staleState = createInitialState('feature');
      staleState = transition(staleState, { type: 'START' });
      saveState({ projectDir, sessionId }, { ...staleState, messageQueue: [makeQueuedMessage()] });

      const next = transitionAndSave({ projectDir, sessionId }, staleState, {
        type: 'PLAN_DONE',
        tasks: [],
      });

      expect(next.phase).toBe('reviewing-plan');
      expect(next.messageQueue).toEqual([expect.objectContaining({ id: 'msg-one' })]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});

describe('queue callers after a persisted clear', () => {
  it.each(['enqueue', 'clear', 'prompt', 'native'] as const)(
    'does not restore a cleared message through %s',
    async (caller) => {
      const ref = setupProject();
      try {
        const { bus } = makeBusRecorder();
        const saved = transitionAndSave(ref, createInitialState('feature'), { type: 'START' });
        const stale = enqueueUserMessage({
          ...ref,
          state: saved,
          message: plainUserMessage('cleared correction'),
          phase: saved.phase,
          bus,
        }).state;
        clearPendingQueue({ ...ref, state: stale, bus });

        if (caller === 'enqueue') {
          const submitted = enqueueUserMessage({
            ...ref,
            state: stale,
            message: plainUserMessage('new correction'),
            phase: stale.phase,
            bus,
          });
          expect(submitted.result.status).toBe('accepted');
          expect(submitted.state.messageQueue.map((message) => message.text)).toEqual([
            'new correction',
          ]);
        } else if (caller === 'clear') {
          expect(clearPendingQueue({ ...ref, state: stale, bus })).toMatchObject({
            count: 0,
            state: { messageQueue: [] },
          });
        } else if (caller === 'prompt') {
          const read = readQueueForPrompt({ ...ref, state: stale });
          for (const message of read.messages) releaseQueuedMessage(ref, message.id, 'prompt');
          expect(read.messages).toEqual([]);
          expect(read.state.messageQueue).toEqual([]);
        } else {
          const message = stale.messageQueue[0];
          if (message === undefined) throw new Error('missing enqueued message');
          const injectUserTurn = vi.fn().mockResolvedValue({ status: 'delivered', usage: null });
          const result = await dispatchNativeInjection({
            ...ref,
            message,
            planner: makePlanner({ injectUserTurn }),
            getState: () => stale,
            setState: vi.fn(),
            bus,
          });
          expect(result).toEqual({ status: 'not-delivered', reason: 'cleared' });
          expect(injectUserTurn).not.toHaveBeenCalled();
        }
        expect(loadState(ref)?.messageQueue.map((message) => message.text)).toEqual(
          caller === 'enqueue' ? ['new correction'] : [],
        );
      } finally {
        cleanupTempDir(ref.projectDir);
      }
    },
  );
});

describe('a state saved as v3', () => {
  function setupV3(): { ref: { projectDir: string; sessionId: string }; file: string } {
    const ref = setupProject();
    const file = join(sessionDir(ref.projectDir, ref.sessionId), 'state.json');
    writeFileSync(file, JSON.stringify(makeLegacyV3State('v3 run')));
    return { ref, file };
  }

  it('reads as the v4 state it loads as, with the revision of its own bytes', () => {
    const { ref, file } = setupV3();
    try {
      const head = readWorkflowStateHead(ref);

      expect(head?.state).toEqual(loadState(ref));
      expect(head?.state.stateVersion).toBe(4);
      expect(head?.digest).toBe(createHash('sha256').update(readFileSync(file)).digest('hex'));
      // An open run, never ready to apply: a v3 run has no workspace.
      const state = head?.state ?? createInitialState('none');
      expect(deriveRunStatus({ state, liveness: 'not-alive' }).kind).toBe('open');
    } finally {
      cleanupTempDir(ref.projectDir);
    }
  });

  it('hands a correction it queued to the next prompt', () => {
    const ref = setupProject();
    const file = join(sessionDir(ref.projectDir, ref.sessionId), 'state.json');
    writeFileSync(
      file,
      JSON.stringify({ ...makeLegacyV3State('v3 run'), messageQueue: [makeQueuedMessage()] }),
    );
    try {
      const loaded = loadState(ref);
      if (loaded === null) throw new Error('the v3 state did not load');

      const read = readQueueForPrompt({ ...ref, state: loaded });

      expect(read.messages.map((message) => message.text)).toEqual([
        'queued while planner was running',
      ]);
    } finally {
      cleanupTempDir(ref.projectDir);
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
      expect(prompted).toMatchObject({
        issueId: issue.id,
        reason: issue.reason,
        headline: formatRecoveryHeadline(issue),
        resumeCommand: formatResumeCommand(sessionId, issue),
      });
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

describe('parkStoppedRun', () => {
  it('parks the run at the step it picks up at and records the stop as a row', async () => {
    const { projectDir, sessionId } = setupProject();
    try {
      const bus = createEventBus();
      const events: EngineEvent[] = [];
      bus.subscribe((event) => events.push(event));
      const state = { ...createInitialState('feature'), phase: 'reviewing-spec' as const };

      const next = await parkStoppedRun({ projectDir, sessionId, bus }, state);

      const gate = { kind: 'gate', gate: 'spec' } as const;
      expect(next.interruptedStep).toMatchObject({ step: gate, source: 'user', cut: 'boundary' });
      expect(loadState({ projectDir, sessionId })?.interruptedStep).toMatchObject({
        step: gate,
        cut: 'boundary',
      });
      expect(events).toEqual([
        {
          type: 'turn_interrupted',
          ts: expect.any(Number),
          phase: 'reviewing-spec',
          source: 'user',
          at: 'boundary',
          step: gate,
        },
      ]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('a park already recorded stands: a second stop changes nothing and adds no row', async () => {
    const { projectDir, sessionId } = setupProject();
    try {
      const bus = createEventBus();
      const events: EngineEvent[] = [];
      bus.subscribe((event) => events.push(event));
      const parked = transition(
        { ...createInitialState('feature'), phase: 'planning' as const },
        {
          type: 'INTERRUPT_STEP',
          step: { kind: 'planner', call: 'plan' },
          source: 'watchdog',
          cut: 'mid-step',
        },
      );
      saveState({ projectDir, sessionId }, parked);

      const next = await parkStoppedRun({ projectDir, sessionId, bus }, parked);

      expect(next).toBe(parked);
      expect(loadState({ projectDir, sessionId })?.interruptedStep).toEqual(parked.interruptedStep);
      expect(events).toEqual([]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
