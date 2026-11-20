import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { QueuedMessage } from '../../../core/schemas/workflow/queue.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { Config } from '../../../core/schemas/config.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { STATE_FILE, sessionDir } from '../../../core/paths.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { enableDebugLog, loggedDiagnostics } from '#testing/helpers/debug-log.js';
import { resetLoggerForTests } from '../../../lib/logger.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { setupProject, makeResearchingState } from '#testing/helpers/queue.js';
import { createWriteSequencer } from '../../../utils/serial-executor.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { createQueueHandler } from './submit.js';
import { readMessages } from '../../../core/sessions/log/reader.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import {
  attachedMessage,
  expectCompactMessage,
  expectResumedMessage,
} from '#testing/helpers/user-message.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue/state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createSteeringPort } from '../../calls/steering.js';
import { formatDrainedMessages } from './prompt.js';
import { MAX_QUEUE_SIZE } from './types.js';

let dirs: string[] = [];

afterEach(() => {
  resetLoggerForTests();
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

describe('enqueue', () => {
  const fullQueue: QueuedMessage[] = Array.from({ length: MAX_QUEUE_SIZE }, (_, index) => ({
    id: `msg-${index}`,
    ...plainUserMessage(`message ${index}`),
    queuedAt: new Date().toISOString(),
    phase: 'researching' as const,
    deliveredViaNative: false,
    nativeDeliveryState: 'pending' as const,
  }));

  it('delivers an attached file through the queue and publishes compact text once before status', async () => {
    const ref = setupProject(dirs);
    const message = attachedMessage(ref.projectDir);
    let state: WorkflowState = makeResearchingState();
    const { bus, events } = makeBusRecorder();
    bus.subscribe(createJsonlSink(ref));
    const injected: string[] = [];
    const serialize = createWriteSequencer();
    const planner = makePlanner({
      capabilities: { ...makePlanner().capabilities, supportsSessionResume: true },
      injectUserTurn: async ({ text }) => {
        injected.push(text);
        return { status: 'delivered', usage: null };
      },
    });
    const handler = createQueueHandler({
      config: makeConfig(),
      ...ref,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
      planner,
      serialize,
    });
    expect(await handler(message, 'researching')).toMatchObject({ status: 'accepted' });
    await serialize(() => {});
    expect(injected[0]).toContain('PELICAN-42');
    expect(formatDrainedMessages(state.messageQueue)).toContain('PELICAN-42');
    expect(state.messageQueue[0]).toMatchObject(message);
    expect(events.findIndex((event) => event.type === 'user_message')).toBeLessThan(
      events.findIndex((event) => event.type === 'message_queued'),
    );
    await expectCompactMessage(ref, events, message);
    await expectResumedMessage(ref, message);
  });

  it('publishes and logs no attached message when enqueue is rejected', async () => {
    const ref = setupProject(dirs);
    const message = attachedMessage(ref.projectDir);
    const { bus, events } = makeBusRecorder();
    bus.subscribe(createJsonlSink(ref));
    const handler = createQueueHandler({
      config: makeConfig(),
      ...ref,
      getState: () => createInitialState('feat'),
      setState: () => {},
      bus,
      planner: makePlanner(),
      serialize: createWriteSequencer(),
    });
    expect(await handler(message, 'idle')).toMatchObject({ status: 'rejected' });
    expect(events.filter((event) => event.type === 'user_message')).toEqual([]);
    const logged = [];
    for await (const entry of readMessages(ref)) {
      if (entry.role === 'user') logged.push(entry);
    }
    expect(logged).toEqual([]);
  });

  it('does not count reviewer history against the pending queue limit', async () => {
    const ref = setupProject(dirs);
    let state: WorkflowState = {
      ...makeResearchingState(),
      phase: 'implementing',
      messageQueue: Array.from({ length: 50 }, (_, index) => ({
        id: `reviewed-${index}`,
        ...plainUserMessage('reviewed requirement'),
        queuedAt: new Date().toISOString(),
        phase: 'final-review',
        deliveredViaNative: false,
        nativeDeliveryState: 'pending',
        deliveredTo: { reviewer: new Date().toISOString() },
      })),
    };
    const { bus } = makeBusRecorder();
    const handler = createQueueHandler({
      config: makeConfig(),
      ...ref,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
      planner: makePlanner(),
      serialize: createWriteSequencer(),
    });

    expect(
      await handler(plainUserMessage('new pending requirement'), 'implementing'),
    ).toMatchObject({
      status: 'accepted',
    });
    expect(state.messageQueue).toHaveLength(51);
  });

  it.each([
    { phase: 'implementing', seat: 'build', taskId: 'T002', native: false, reviewing: false },
    { phase: 'implementing', seat: 'review', taskId: undefined, native: false, reviewing: true },
    { phase: 'final-review', seat: 'review', taskId: undefined, native: false, reviewing: false },
    { phase: 'planning', seat: 'plan', taskId: undefined, native: true, reviewing: false },
  ] as const)(
    'routes input to $seat during $phase (task review running: $reviewing)',
    async ({ phase, seat, taskId, native, reviewing }) => {
      const { projectDir, sessionId } = setupProject(dirs);
      const done = makeTask({ id: 'T001', status: 'done' });
      let state: WorkflowState = {
        ...makeResearchingState(),
        phase,
        tasks: [done, makeTask({ id: 'T002' })],
        currentTaskIndex: 1,
        ...(reviewing && { pendingScheduledReview: { afterTaskId: done.id } }),
      };
      const { bus, events } = makeBusRecorder();
      const injectUserTurn = vi.fn(async () => ({ status: 'delivered' as const, usage: null }));
      const planner = makePlanner({
        capabilities: {
          supportsConversationalPlanning: true,
          supportsSessionResume: true,
          supportsEffort: false,
          supportsImages: false,
          supportsSelfSummarisation: false,
        },
        injectUserTurn,
      });
      const serialize = createWriteSequencer();
      const handler = createQueueHandler({
        config: makeConfig(),
        projectDir,
        sessionId,
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        bus,
        planner,
        serialize,
      });

      expect(await handler(plainUserMessage('check the running work'), phase)).toMatchObject({
        status: 'accepted',
      });
      await serialize(() => {});

      expect(injectUserTurn).toHaveBeenCalledTimes(native ? 1 : 0);
      const message = loadState({ projectDir, sessionId })?.messageQueue[0];
      if (message === undefined) throw new Error('expected queued message');
      expect(isQueuedMessagePendingDelivery(message)).toBe(!native);
      const queued = events.find((event) => event.type === 'message_queued');
      expect(queued).toMatchObject({ seat, ...(taskId === undefined ? {} : { taskId }) });
      if (taskId === undefined) expect(queued).not.toHaveProperty('taskId');
    },
  );

  it.each(['pending', 'in_progress'] as const)(
    'marks a BUILD message for a %s brief as read when its call starts',
    async (status) => {
      const { projectDir, sessionId } = setupProject(dirs);
      const done = makeTask({ id: 'T001', status: 'done' });
      const current = makeTask({ id: 'T002', status });
      let state: WorkflowState = {
        ...makeResearchingState(),
        phase: 'implementing',
        tasks: [done, current],
        currentTaskIndex: 1,
      };
      const { bus, events } = makeBusRecorder();
      const handler = createQueueHandler({
        config: makeConfig(),
        projectDir,
        sessionId,
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        bus,
        planner: makePlanner(),
        serialize: createWriteSequencer(),
      });

      expect(await handler(plainUserMessage('check timing'), 'implementing')).toMatchObject({
        status: 'accepted',
      });

      const queued = events.find((event) => event.type === 'message_queued');
      if (queued?.type !== 'message_queued') throw new Error('message_queued missing');
      expect(queued.taskId).toBe('T002');
      if (status === 'pending') {
        expect(queued.starting).toBe(true);
      } else {
        expect(queued.starting).toBeUndefined();
        expect(queued).not.toHaveProperty('starting');
      }
    },
  );

  it('enqueues a message into state and emits message-queued event', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner();

    const handler = createQueueHandler({
      config: makeConfig(),
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      planner,
      serialize: createWriteSequencer(),
    });

    const result = await handler(plainUserMessage('hello world'), 'researching');

    expect(result.status).toBe('accepted');
    expect(state?.messageQueue).toHaveLength(1);
    expect(state?.messageQueue[0]?.text).toBe('hello world');
    expect(state?.messageQueue[0]?.phase).toBe('researching');
    expect(state?.messageQueue[0]?.deliveredViaNative).toBe(false);
    expect(events.find((e) => e.type === 'message_queued')).toBeDefined();
  });

  it('emits a redacted preview for queued messages', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner();

    const handler = createQueueHandler({
      config: makeConfig(),
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      planner,
      serialize: createWriteSequencer(),
    });

    const result = await handler(
      plainUserMessage('token sk-proj-abcdefghijklmnopqrstuvwxyz'),
      'researching',
    );

    expect(result.status).toBe('accepted');
    const queued = events.find((event) => event.type === 'message_queued');
    if (queued?.type !== 'message_queued') throw new Error('message_queued missing');
    expect(queued.preview).toContain('sk-***REDACTED***');
    expect(queued.preview).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('delivers queued input natively when the planner supports injection', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus } = makeBusRecorder();
    const injectedTurns: Array<{ text: string; dir: string }> = [];
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: true,
        supportsSessionResume: true,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
      injectUserTurn: async (injection) => {
        injectedTurns.push({ text: injection.text, dir: injection.projectDir });
        return { status: 'delivered', usage: null };
      },
    });

    const handler = createQueueHandler({
      config: makeConfig(),
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      planner,
      serialize: createWriteSequencer(),
    });

    const result = await handler(plainUserMessage('inject me'), 'researching');

    await new Promise((r) => setTimeout(r, 0));

    expect(result.status).toBe('accepted');
    expect(injectedTurns).toHaveLength(1);
    expect(injectedTurns[0]?.text).toBe('inject me');
    expect(injectedTurns[0]?.dir).toBe(projectDir);
  });

  it('does not enqueue when state getter returns undefined', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: false,
        supportsSessionResume: false,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
      injectUserTurn: async () => ({ status: 'delivered', usage: null }),
    });
    let writtenState: WorkflowState | undefined;
    const setState = (s: WorkflowState) => {
      writtenState = s;
    };

    const handler = createQueueHandler({
      config: makeConfig(),
      projectDir,
      sessionId,
      getState: () => undefined,
      setState,
      bus,
      planner,
      serialize: createWriteSequencer(),
    });

    const result = await handler(plainUserMessage('no state'), 'researching');

    expect(result.status).toBe('rejected');
    expect(writtenState).toBeUndefined();
    expect(events.find((e) => e.type === 'message_queued')).toBeUndefined();
  });

  it('does not enqueue when the queue is full and publishes no warning', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = {
      ...makeResearchingState(),
      messageQueue: fullQueue,
    };
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner();

    const handler = createQueueHandler({
      config: makeConfig(),
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      planner,
      serialize: createWriteSequencer(),
    });

    const result = await handler(plainUserMessage('overflow'), 'researching');

    expect(result).toMatchObject({ status: 'rejected', reason: 'queue-full' });
    expect(events.filter((event) => event.type === 'warning')).toEqual([]);
    expect(state?.messageQueue).toHaveLength(MAX_QUEUE_SIZE);
  });

  it('returns a failed result when the queue itself throws', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus, events } = makeBusRecorder();
    enableDebugLog(projectDir);
    writeFileSync(join(sessionDir(projectDir, sessionId), STATE_FILE), '{"tru');
    const writes: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      const handler = createQueueHandler({
        config: makeConfig(),
        projectDir,
        sessionId,
        getState: () => state,
        setState: (s) => {
          state = s;
        },
        bus,
        planner: makePlanner(),
        serialize: createWriteSequencer(),
      });

      const result = await handler(plainUserMessage('survive a broken state file'), 'researching');

      expect(result).toEqual({
        status: 'rejected',
        reason: 'failed',
        message: 'Cannot queue message: workflow queue failed.',
      });
    } finally {
      stderr.mockRestore();
    }

    expect(writes.join('')).not.toContain('Could not queue your message');
    expect(loggedDiagnostics(projectDir)).toContainEqual(
      expect.stringContaining('Could not queue your message'),
    );
    expect(events.filter((event) => event.type === 'warning')).toEqual([]);
    expect(state?.messageQueue).toHaveLength(0);
  });

  it.each([
    ['that cannot save the queue', false],
    ['after a deferred mid-call send', true],
  ] as const)('writes a plan injection %s to the debug log only', async (_when, deferred) => {
    const ref = setupProject(dirs);
    enableDebugLog(ref.projectDir);
    let state = makeResearchingState();
    const { bus } = makeBusRecorder();
    const steering = createSteeringPort();
    const send = vi.fn(async () => 'deferred' as const);
    if (deferred) steering.attach({ callId: 'deferred-plan', role: 'planner', taskId: null, send });
    const handler = createQueueHandler({
      config: makeConfig(),
      ...ref,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
      steering,
      planner: makePlanner({
        injectUserTurn: async () => {
          writeFileSync(join(sessionDir(ref.projectDir, ref.sessionId), STATE_FILE), '{"tru');
          throw new Error('planner turn failed');
        },
      }),
      serialize: createWriteSequencer(),
    });
    const writes: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      expect(await handler(plainUserMessage('reach the planner'), 'researching')).toMatchObject({
        status: 'accepted',
      });
      await vi.waitFor(() =>
        expect(loggedDiagnostics(ref.projectDir)).toContainEqual(
          expect.stringContaining('Could not deliver your queued message'),
        ),
      );
    } finally {
      stderr.mockRestore();
    }

    expect(send).toHaveBeenCalledTimes(deferred ? 1 : 0);
    expect(writes.join('')).not.toContain('Could not deliver your queued message');
  });

  it('accepts input during a brief and queues it durably for the boundary', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = {
      ...makeResearchingState(),
      phase: 'implementing',
    };
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner();

    const handler = createQueueHandler({
      config: makeConfig(),
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      planner,
      serialize: createWriteSequencer(),
    });

    const result = await handler(plainUserMessage('keep this for after'), 'implementing');

    expect(result).toMatchObject({ status: 'accepted' });
    expect(state?.messageQueue.map((m) => m.text)).toEqual(['keep this for after']);
    expect(events.find((event) => event.type === 'message_queued')).toBeDefined();
    // Durable: the persisted head carries it, so a restart still drains it once.
    expect(loadState({ projectDir, sessionId })?.messageQueue.map((m) => m.text)).toEqual([
      'keep this for after',
    ]);
  });

  it.each<
    [string, Phase, WorkflowState, Config, 'phase-unavailable' | 'queue-full', string, number]
  >([
    [
      'idle',
      'idle',
      { ...makeResearchingState(), phase: 'idle' },
      makeConfig(),
      'phase-unavailable',
      'The queue takes a message only while a run is live.',
      0,
    ],
    [
      'a REVIEW None pass under Apply',
      'final-review',
      {
        ...makeResearchingState(),
        phase: 'final-review',
        workspace: {
          kind: 'worktree',
          path: '/tmp/wt',
          base: { snapshotId: 'b', head: null },
        },
      },
      makeConfig({ reviewer: 'none' }),
      'phase-unavailable',
      'Apply takes no message. Clear the input first.',
      0,
    ],
    [
      'a full queue',
      'researching',
      { ...makeResearchingState(), messageQueue: fullQueue },
      makeConfig(),
      'queue-full',
      `Queue full (${MAX_QUEUE_SIZE} messages). Wait for the current phase to complete.`,
      MAX_QUEUE_SIZE,
    ],
  ])(
    'refuses %s with one reason and publishes no warning',
    async (_label, phase, initial, config, reason, message, queued) => {
      const { projectDir, sessionId } = setupProject(dirs);
      let state: WorkflowState | undefined = initial;
      const { bus, events } = makeBusRecorder();

      const handler = createQueueHandler({
        config,
        projectDir,
        sessionId,
        getState: () => state,
        setState: (s) => {
          state = s;
        },
        bus,
        planner: makePlanner(),
        serialize: createWriteSequencer(),
      });

      const result = await handler(plainUserMessage('should not queue'), phase);

      expect(result).toEqual({ status: 'rejected', reason, message });
      expect(events.find((event) => event.type === 'message_queued')).toBeUndefined();
      expect(events.filter((event) => event.type === 'warning')).toEqual([]);
      expect(state?.messageQueue).toHaveLength(queued);
      expect(loadState({ projectDir, sessionId })?.messageQueue ?? []).toHaveLength(0);
    },
  );

  it.each<[string, WorkflowState['workspace'], string]>([
    [
      'on a worktree',
      { kind: 'worktree', path: '/tmp/wt', base: { snapshotId: 'b', head: null } },
      'Apply takes no message. Clear the input first.',
    ],
    [
      'on the project checkout',
      { kind: 'checkout', path: '/tmp/project', base: { snapshotId: 'b', head: null } },
      'The review takes no message. Clear the input first.',
    ],
    [
      'with no workspace recorded',
      undefined,
      'The review takes no message. Clear the input first.',
    ],
  ])(
    'refuses a message during a REVIEW None pass %s, as no seat reads it',
    async (_, workspace, refusal) => {
      const { projectDir, sessionId } = setupProject(dirs);
      let state: WorkflowState | undefined = {
        ...makeResearchingState(),
        phase: 'final-review',
        workspace,
      };
      const { bus, events } = makeBusRecorder();

      const handler = createQueueHandler({
        config: makeConfig({ reviewer: 'none' }),
        projectDir,
        sessionId,
        getState: () => state,
        setState: (s) => {
          state = s;
        },
        bus,
        planner: makePlanner(),
        serialize: createWriteSequencer(),
      });

      const result = await handler(plainUserMessage('also fix the typo'), 'final-review');

      expect(result).toEqual({
        status: 'rejected',
        reason: 'phase-unavailable',
        message: refusal,
      });
      expect(state?.messageQueue).toHaveLength(0);
      expect(loadState({ projectDir, sessionId })?.messageQueue ?? []).toHaveLength(0);
      expect(events.find((event) => event.type === 'message_queued')).toBeUndefined();
      expect(events.filter((event) => event.type === 'warning')).toEqual([]);
    },
  );

  describe('a message during a due task review under REVIEW None', () => {
    const WORKTREE = {
      kind: 'worktree' as const,
      path: '/tmp/wt',
      base: { snapshotId: 'b', head: null },
    };
    const done = makeTask({ id: 'T001', status: 'done' });

    function noneHandler(tasks: WorkflowState['tasks']) {
      const { projectDir, sessionId } = setupProject(dirs);
      let state: WorkflowState | undefined = {
        ...makeResearchingState(),
        phase: 'implementing',
        tasks,
        currentTaskIndex: 1,
        pendingScheduledReview: { afterTaskId: done.id },
        workspace: WORKTREE,
      };
      const handler = createQueueHandler({
        config: makeConfig({ reviewer: 'none' }),
        projectDir,
        sessionId,
        getState: () => state,
        setState: (s) => {
          state = s;
        },
        bus: makeBusRecorder().bus,
        planner: makePlanner(),
        serialize: createWriteSequencer(),
      });
      return { handler, queued: () => state?.messageQueue ?? [] };
    }

    it('refuses it when no brief is left, as no seat reads it', async () => {
      const { handler, queued } = noneHandler([done]);

      const result = await handler(plainUserMessage('also fix the typo'), 'implementing');

      expect(result).toEqual({
        status: 'rejected',
        reason: 'phase-unavailable',
        message: 'Apply takes no message. Clear the input first.',
      });
      expect(queued()).toHaveLength(0);
    });

    it('queues it for the next brief when one is left', async () => {
      const { handler, queued } = noneHandler([done, makeTask({ id: 'T002' })]);

      const result = await handler(plainUserMessage('also fix the typo'), 'implementing');

      expect(result.status).not.toBe('rejected');
      expect(queued()).toHaveLength(1);
    });
  });

  it('persists later messages before a slow native injection resolves', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus } = makeBusRecorder();
    let releaseFirst: (() => void) | undefined;
    const firstInjection = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let injectionCount = 0;
    const planner = makePlanner({
      capabilities: {
        supportsConversationalPlanning: true,
        supportsSessionResume: true,
        supportsEffort: false,
        supportsImages: false,
        supportsSelfSummarisation: false,
      },
      injectUserTurn: async () => {
        injectionCount += 1;
        if (injectionCount === 1) await firstInjection;
        return { status: 'delivered', usage: null };
      },
    });

    const handler = createQueueHandler({
      config: makeConfig(),
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      planner,
      serialize: createWriteSequencer(),
    });

    const first = handler(plainUserMessage('first'), 'researching');
    const second = handler(plainUserMessage('second'), 'researching');
    await new Promise((r) => setTimeout(r, 0));

    await expect(first).resolves.toMatchObject({ status: 'accepted' });
    await expect(second).resolves.toMatchObject({ status: 'accepted' });
    expect(state?.messageQueue.map((m) => m.text)).toEqual(['first', 'second']);
    expect(loadState({ projectDir, sessionId })?.messageQueue.map((m) => m.text)).toEqual([
      'first',
      'second',
    ]);
    releaseFirst?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(injectionCount).toBeGreaterThanOrEqual(1);
  });

  it('serializes concurrent handler invocations so no messages are lost', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus } = makeBusRecorder();
    const planner = makePlanner();
    const serialize = createWriteSequencer();

    const handler = createQueueHandler({
      config: makeConfig(),
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      planner,
      serialize,
    });

    const results = await Promise.all([
      handler(plainUserMessage('first'), 'researching'),
      handler(plainUserMessage('second'), 'researching'),
      handler(plainUserMessage('third'), 'researching'),
    ]);

    expect(results.every((result) => result.status === 'accepted')).toBe(true);
    expect(state?.messageQueue).toHaveLength(3);
    expect(state?.messageQueue.map((m) => m.text)).toEqual(['first', 'second', 'third']);
  });

  it('preserves queued messages when a later orchestrator transition starts from stale state', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = transitionAndSave(
      { projectDir, sessionId },
      createInitialState('test-feature'),
      { type: 'START' },
    );
    const staleState = state;
    const { bus } = makeBusRecorder();
    const planner = makePlanner();

    const handler = createQueueHandler({
      config: makeConfig(),
      projectDir,
      sessionId,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      bus,
      planner,
      serialize: createWriteSequencer(),
    });

    await expect(handler(plainUserMessage('do not drop me'), 'researching')).resolves.toMatchObject(
      {
        status: 'accepted',
      },
    );

    state = transitionAndSave({ projectDir, sessionId }, staleState, {
      type: 'PLAN_DONE',
      tasks: [],
    });

    expect(state.messageQueue.map((m) => m.text)).toEqual(['do not drop me']);
    expect(state.phase).toBe('reviewing-plan');
  });
});
