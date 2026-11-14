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
import { briefCorrections } from '../../../core/state/lineage.js';
import { loadState } from '../../../core/state/persistence.js';
import { STATE_FILE, sessionDir } from '../../../core/paths.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { enableDebugLog, loggedDiagnostics } from '#testing/helpers/debug-log.js';
import { resetLoggerForTests } from '../../../lib/logger.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { setupProject, makeResearchingState } from '#testing/helpers/queue.js';
import { createWriteSequencer } from '../serial-executor.js';
import { transitionAndSave } from '../state-ops.js';
import { createQueueHandler } from './submit.js';
import { readMessages } from '../../../core/sessions/log/reader.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import {
  attachedMessage,
  expectCompactMessage,
  expectResumedMessage,
} from '#testing/helpers/user-message.js';
import {
  isQueuedMessageClearable,
  isQueuedMessagePendingDelivery,
} from '../../../core/queue/state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createSteeringPort, type RunningCall, type SteerOutcome } from '../../calls/steering.js';
import { settleMidCallDeliveries } from './mid-call.js';
import { formatDrainedMessages } from './prompt.js';
import { clearPendingQueue } from './clear.js';
import { drainQueue, drainQueueForReview } from './drain.js';
import { MAX_QUEUE_SIZE } from './types.js';

let dirs: string[] = [];

afterEach(() => {
  resetLoggerForTests();
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

describe('mid-call delivery', () => {
  it.each([
    { phase: 'planning', role: 'planner', taskId: null },
    { phase: 'implementing', role: 'implementer', taskId: 'T001' },
    { phase: 'final-review', role: 'review', taskId: null },
  ] as const)(
    'keeps attachments in a mid-call delivery during $phase',
    async ({ phase, role, taskId }) => {
      const ref = setupProject(dirs);
      const message = attachedMessage(ref.projectDir);
      message.images = [
        {
          id: 'image-1',
          kind: 'image',
          path: '/outside/shot.png',
          mimeType: 'image/png',
          sizeBytes: 5,
        },
      ];
      message.attachedInputs.push({ kind: 'image', path: '/outside/shot.png' });
      let state: WorkflowState = { ...makeResearchingState(), phase, tasks: [makeTask()] };
      const { bus } = makeBusRecorder();
      const steering = createSteeringPort();
      const send = vi.fn(async () => 'delivered' as const);
      steering.attach({ callId: 'attached-call', role, taskId, send });
      const handler = createQueueHandler({
        config: makeConfig(),
        ...ref,
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        bus,
        steering,
        planner: makePlanner(),
        serialize: createWriteSequencer(),
      });

      expect(await handler(message, phase)).toMatchObject({ status: 'accepted' });
      await settleMidCallDeliveries(ref);

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          id: state.messageQueue[0]?.id,
          text: expect.stringContaining(message.text),
          images: message.images,
          attachedInputs: message.attachedInputs,
        }),
      );
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('[image:image-1] = /outside/shot.png'),
        }),
      );
      expect(loadState(ref)?.messageQueue[0]).toMatchObject(message);
    },
  );

  const seats = [
    { phase: 'implementing', seat: 'build', role: 'implementer', taskId: 'T001' },
    { phase: 'planning', seat: 'plan', role: 'planner', taskId: null },
    { phase: 'final-review', seat: 'review', role: 'review', taskId: null },
  ] as const;
  const outcomes: SteerOutcome[] = ['delivered', 'deferred', 'uncertain'];

  it.each(seats.flatMap((seat) => outcomes.map((outcome) => ({ ...seat, outcome }))))(
    '$outcome during $seat persists the outcome and selects the fallback',
    async ({ phase, seat, role, taskId, outcome }) => {
      const ref = setupProject(dirs);
      const task = makeTask();
      let state: WorkflowState = { ...makeResearchingState(), phase, tasks: [task] };
      const { bus, events } = makeBusRecorder();
      const injectUserTurn = vi.fn(async () => ({ status: 'delivered' as const, usage: null }));
      const steering = createSteeringPort();
      const send = vi.fn(async () => outcome);
      const detach = steering.attach({ callId: 'live-call', role, taskId, send });
      const serialize = createWriteSequencer();
      const handler = createQueueHandler({
        config: makeConfig(),
        ...ref,
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        bus,
        planner: makePlanner({ injectUserTurn }),
        serialize,
        steering,
      });

      const result = await handler(plainUserMessage('preserve the queue history'), phase);
      await settleMidCallDeliveries(ref);
      await serialize(() => {});
      detach();

      expect(result).toMatchObject({ status: 'accepted' });
      expect(send).toHaveBeenCalledWith({
        id: state.messageQueue[0]?.id,
        text: 'preserve the queue history',
      });
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'message_queued', seat, steerable: true }),
      );
      const message = loadState(ref)?.messageQueue[0];
      if (message === undefined) throw new Error('expected queued message');
      expect(injectUserTurn).toHaveBeenCalledTimes(
        outcome === 'deferred' && seat === 'plan' ? 1 : 0,
      );

      if (outcome === 'delivered') {
        expect(message.deliveredMidCall).toBe(true);
        expect(isQueuedMessagePendingDelivery(message)).toBe(seat === 'review');
        expect(state.stateRevision).toBe(seat === 'build' ? 3 : 2);
        if (seat === 'build') {
          expect(message.deliveredTo?.implementer).toBeDefined();
          expect(briefCorrections(state, task.id)).toEqual([
            formatDrainedMessages([message]).trim(),
          ]);
        } else if (seat === 'plan') {
          expect(message.deliveredViaNative).toBe(true);
          expect(message.nativeDeliveryState).toBe('delivered');
        } else {
          expect(message.deliveredTo?.reviewer).toBeDefined();
          expect(message.deliveredTo?.implementer).toBeUndefined();
          expect(isQueuedMessageClearable(message)).toBe(false);
          expect((await drainQueueForReview({ ...ref, state, bus })).messages).toEqual([]);
          const built = drainQueue({ ...ref, state, bus });
          expect(built.messages.map((queued) => queued.text)).toEqual([message.text]);
          expect(built.state.messageQueue[0]?.deliveredTo?.implementer).toBeDefined();
        }
        expect(
          events.filter((event) => event.type === 'queue_drained' && event.via === 'mid-call'),
        ).toEqual([
          expect.objectContaining({
            seat,
            via: 'mid-call',
            ids: [message.id],
            count: 1,
            ...(taskId === null ? {} : { taskId }),
          }),
        ]);
        expect(events.some((event) => event.type === 'message_injected_native')).toBe(false);
      } else {
        expect(message.deliveredMidCall).toBeUndefined();
        expect(events.some((event) => event.type === 'queue_drained')).toBe(false);
        expect(isQueuedMessagePendingDelivery(message)).toBe(
          outcome !== 'deferred' || seat !== 'plan',
        );
        expect(message.possibleDuplicate).toBe(outcome === 'uncertain' ? true : undefined);
        if (outcome === 'uncertain') {
          expect(formatDrainedMessages([message])).toContain(
            'You may have seen this message already during your last call:',
          );
        }
      }
    },
  );

  it('registers delivery before the enqueue callback returns', async () => {
    const ref = setupProject(dirs);
    let state: WorkflowState = {
      ...makeResearchingState(),
      phase: 'implementing',
      tasks: [makeTask()],
    };
    const { bus } = makeBusRecorder();
    const steering = createSteeringPort();
    const outcome = Promise.withResolvers<SteerOutcome>();
    steering.attach({
      callId: 'queue-break',
      role: 'implementer',
      taskId: 'T001',
      send: () => outcome.promise,
    });
    let settling: Promise<void> | undefined;
    let settled = false;
    const handler = createQueueHandler({
      config: makeConfig(),
      ...ref,
      getState: () => state,
      setState: (next) => {
        state = next;
        settling ??= settleMidCallDeliveries(ref).then(() => {
          settled = true;
        });
      },
      bus,
      planner: makePlanner(),
      serialize: createWriteSequencer(),
      steering,
    });

    await handler(plainUserMessage('wait for this acknowledgement'), 'implementing');
    await Promise.resolve();
    const settledBeforeAck = settled;
    outcome.resolve('delivered');
    await settling;
    await settleMidCallDeliveries(ref);

    expect(settledBeforeAck).toBe(false);
    expect(state.messageQueue[0]?.deliveredTo?.implementer).toBeDefined();
    expect(briefCorrections(state, makeTask().id)).toHaveLength(1);
  });

  it.each([null, 'missing-task'])(
    'marks a BUILD delivery uncertain when its task ID is %s',
    async (taskId) => {
      const ref = setupProject(dirs);
      const task = makeTask();
      let state: WorkflowState = {
        ...makeResearchingState(),
        phase: 'implementing',
        tasks: [task],
      };
      const { bus, events } = makeBusRecorder();
      const steering = createSteeringPort();
      steering.attach({
        callId: 'missing-task',
        role: 'implementer',
        taskId,
        send: async () => 'delivered',
      });
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
        steering,
      });

      await handler(plainUserMessage('keep the task association exact'), 'implementing');
      await expect(settleMidCallDeliveries(ref)).resolves.toBeUndefined();

      expect(briefCorrections(state, task.id)).toEqual([]);
      expect(state.messageQueue[0]?.deliveredTo?.implementer).toBeUndefined();
      expect(state.messageQueue[0]?.possibleDuplicate).toBe(true);
      expect(loadState(ref)?.messageQueue[0]?.possibleDuplicate).toBe(true);
      expect(formatDrainedMessages(state.messageQueue)).toContain(
        'You may have seen this message already during your last call:',
      );
      expect(events.filter((event) => event.type === 'queue_drained')).toEqual([]);
    },
  );

  it('does not track a deferred PLAN native injection in the delivery registry', async () => {
    const ref = setupProject(dirs);
    let state = makeResearchingState();
    const { bus } = makeBusRecorder();
    const steering = createSteeringPort();
    steering.attach({
      callId: 'deferred-plan',
      role: 'planner',
      taskId: null,
      send: async () => 'deferred',
    });
    const injection = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let injecting = true;
    const serialize = createWriteSequencer();
    const handler = createQueueHandler({
      config: makeConfig(),
      ...ref,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
      planner: makePlanner({
        injectUserTurn: async () => {
          started.resolve();
          await injection.promise;
          injecting = false;
          return { status: 'delivered', usage: null };
        },
      }),
      serialize,
      steering,
    });

    await handler(plainUserMessage('use the planner fallback'), 'researching');
    await started.promise;
    const settling = settleMidCallDeliveries(ref);
    let settled = false;
    void settling.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const settledBeforeInjection = settled;
    expect(injecting).toBe(true);
    injection.resolve();
    await settling;
    await serialize(() => {});

    expect(settledBeforeInjection).toBe(true);
    expect(state.messageQueue[0]?.deliveredViaNative).toBe(true);
    expect(state.messageQueue[0]?.deliveredMidCall).toBeUndefined();
  });

  it('keeps a message delivered mid-call to REVIEW as history when clearing', async () => {
    const ref = setupProject(dirs);
    let state: WorkflowState = { ...makeResearchingState(), phase: 'final-review' };
    const { bus } = makeBusRecorder();
    const steering = createSteeringPort();
    steering.attach({
      callId: 'clear-review',
      role: 'review',
      taskId: null,
      send: async () => 'delivered',
    });
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
      steering,
    });

    await handler(plainUserMessage('keep this for BUILD too'), 'final-review');
    await settleMidCallDeliveries(ref);
    const cleared = clearPendingQueue({ ...ref, state, bus });

    expect(cleared.count).toBe(0);
    expect(cleared.state.messageQueue).toHaveLength(1);
    expect(loadState(ref)?.messageQueue[0]?.deliveredTo?.reviewer).toBeDefined();
  });

  it('defers a call from another seat and uses the planner fallback', async () => {
    const ref = setupProject(dirs);
    let state = makeResearchingState();
    const { bus, events } = makeBusRecorder();
    const steering = createSteeringPort();
    const send = vi.fn(async (): Promise<SteerOutcome> => 'delivered');
    steering.attach({ callId: 'build-call', role: 'implementer', taskId: 'T001', send });
    const injectUserTurn = vi.fn(async () => ({ status: 'delivered' as const, usage: null }));
    const serialize = createWriteSequencer();
    const handler = createQueueHandler({
      config: makeConfig(),
      ...ref,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
      planner: makePlanner({ injectUserTurn }),
      serialize,
      steering,
    });

    await handler(plainUserMessage('plan this change'), 'planning');
    await settleMidCallDeliveries(ref);
    await serialize(() => {});

    expect(send).not.toHaveBeenCalled();
    expect(injectUserTurn).toHaveBeenCalledOnce();
    expect(events.find((event) => event.type === 'message_queued')).not.toMatchObject({
      steerable: true,
    });
  });

  it('uses the call captured before the enqueue even when the port changes', async () => {
    const ref = setupProject(dirs);
    let state: WorkflowState = {
      ...makeResearchingState(),
      phase: 'implementing',
      tasks: [makeTask()],
    };
    const { bus } = makeBusRecorder();
    const steering = createSteeringPort();
    const oldSend = vi.fn(async (): Promise<SteerOutcome> => 'deferred');
    const newSend = vi.fn(async (): Promise<SteerOutcome> => 'delivered');
    const oldCall: RunningCall = {
      callId: 'old',
      role: 'implementer',
      taskId: 'T001',
      send: oldSend,
    };
    steering.attach(oldCall);
    const serialize = createWriteSequencer();
    const handler = createQueueHandler({
      config: makeConfig(),
      ...ref,
      getState: () => {
        steering.attach({ ...oldCall, callId: 'new', send: newSend });
        return state;
      },
      setState: (next) => {
        state = next;
      },
      bus,
      planner: makePlanner(),
      serialize,
      steering,
    });

    await handler(plainUserMessage('send to the captured call'), 'implementing');
    await settleMidCallDeliveries(ref);

    expect(oldSend).toHaveBeenCalledOnce();
    expect(newSend).not.toHaveBeenCalled();
    expect(state.messageQueue[0]?.deliveredMidCall).toBeUndefined();
  });

  it('keeps a deferred planner message pending when BUILD takes the phase', async () => {
    const ref = setupProject(dirs);
    let state: WorkflowState = {
      ...makeResearchingState(),
      phase: 'planning',
      tasks: [makeTask()],
    };
    const { bus } = makeBusRecorder();
    const steering = createSteeringPort();
    const outcome = Promise.withResolvers<SteerOutcome>();
    steering.attach({
      callId: 'planner-ending',
      role: 'planner',
      taskId: null,
      send: () => outcome.promise,
    });
    const injectUserTurn = vi.fn(async () => ({ status: 'delivered' as const, usage: null }));
    const handler = createQueueHandler({
      config: makeConfig(),
      ...ref,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
      planner: makePlanner({ injectUserTurn }),
      serialize: createWriteSequencer(),
      steering,
    });
    await handler(plainUserMessage('keep this for the receiving seat'), 'planning');
    state = transitionAndSave(ref, state, { type: 'BEGIN_IMPLEMENTATION' });

    outcome.resolve('deferred');
    await settleMidCallDeliveries(ref);

    expect(injectUserTurn).not.toHaveBeenCalled();
    const message = loadState(ref)?.messageQueue[0];
    if (message === undefined) throw new Error('expected pending message');
    expect(isQueuedMessagePendingDelivery(message)).toBe(true);
  });

  it('returns acceptance and leaves the write sequencer free while a send waits', async () => {
    const ref = setupProject(dirs);
    let state: WorkflowState = {
      ...makeResearchingState(),
      phase: 'implementing',
      tasks: [makeTask()],
    };
    const { bus } = makeBusRecorder();
    const steering = createSteeringPort();
    const outcome = Promise.withResolvers<SteerOutcome>();
    steering.attach({
      callId: 'slow',
      role: 'implementer',
      taskId: 'T001',
      send: () => outcome.promise,
    });
    const serialize = createWriteSequencer();
    const handler = createQueueHandler({
      config: makeConfig(),
      ...ref,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
      planner: makePlanner(),
      serialize,
      steering,
    });

    expect(await handler(plainUserMessage('first message'), 'implementing')).toMatchObject({
      status: 'accepted',
    });
    expect(await handler(plainUserMessage('second message'), 'implementing')).toMatchObject({
      status: 'accepted',
    });
    await serialize(() => {});
    expect(loadState(ref)?.messageQueue).toHaveLength(2);

    outcome.resolve('delivered');
    await settleMidCallDeliveries(ref);
    expect(state.messageQueue.every((message) => message.deliveredMidCall)).toBe(true);
    expect(briefCorrections(state, makeTask().id)).toHaveLength(2);
  });
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
      'Cannot send words to Apply. Clear them.',
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
      'Cannot send words to Apply. Clear them.',
    ],
    [
      'on the project checkout',
      { kind: 'checkout', path: '/tmp/project', base: { snapshotId: 'b', head: null } },
      'Cannot send words to the review. Clear them.',
    ],
    ['with no workspace recorded', undefined, 'Cannot send words to the review. Clear them.'],
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
        message: 'Cannot send words to Apply. Clear them.',
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
