import { makeConfig } from '#testing/helpers/factories/config.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { briefCorrections } from '../../../core/state/lineage.js';
import { loadState } from '../../../core/state/persistence.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetLoggerForTests } from '../../../lib/logger.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { setupProject, makeResearchingState } from '#testing/helpers/queue.js';
import { createWriteSequencer } from '../../../utils/serial-executor.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { createQueueHandler } from './submit.js';
import { attachedMessage } from '#testing/helpers/user-message.js';
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
