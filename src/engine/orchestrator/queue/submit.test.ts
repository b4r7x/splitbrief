import { plainUserMessage } from '../../../core/types/user-input.js';
import { describe, it, expect, afterEach } from 'vitest';
import type { WorkflowState, QueuedMessage } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { setupProject, makeResearchingState } from '#testing/helpers/queue.js';
import { createWriteSequencer } from '../serial-executor.js';
import { transitionAndSave } from '../state-ops.js';
import { createQueueHandler } from './submit.js';
import { readMessages } from '../../../core/sessions/log-reader.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import {
  attachedMessage,
  expectCompactMessage,
  expectResumedMessage,
} from '#testing/helpers/user-message.js';
import { formatDrainedMessages } from './prompt.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

describe('enqueue', () => {
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

  it('enqueues a message into state and emits message-queued event', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner();

    const handler = createQueueHandler({
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

  it('emits warning and does not enqueue when queue is full', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner();

    const fakeMessages: QueuedMessage[] = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      ...plainUserMessage(`message ${i}`),
      queuedAt: new Date().toISOString(),
      phase: 'researching' as const,
      deliveredViaNative: false,
      nativeDeliveryState: 'pending' as const,
    }));
    state = { ...state!, messageQueue: fakeMessages };

    const handler = createQueueHandler({
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
    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toBeDefined();
    expect(state?.messageQueue).toHaveLength(50);
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

  it('still rejects a phase that is not live at the shared queue boundary', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = {
      ...makeResearchingState(),
      phase: 'idle',
    };
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner();

    const handler = createQueueHandler({
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

    const result = await handler(plainUserMessage('should not queue'), 'idle');

    expect(result).toMatchObject({ status: 'rejected', reason: 'phase-unavailable' });
    expect(state?.messageQueue).toHaveLength(0);
    expect(events.find((event) => event.type === 'message_queued')).toBeUndefined();
    const warning = events.find((event) => event.type === 'warning');
    expect(warning).toMatchObject({
      type: 'warning',
      category: 'queue',
      code: 'phase_unavailable',
      message: 'Queue is only available while a run is live; current phase is idle.',
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
