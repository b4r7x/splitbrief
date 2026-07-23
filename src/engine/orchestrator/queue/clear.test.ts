import { describe, it, expect, afterEach } from 'vitest';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import {
  setupProject,
  makeResearchingState,
  makeStateWithQueue,
  makeMessage,
} from '#testing/helpers/queue.js';
import { createWriteSequencer } from '../serial-executor.js';
import { createClearQueueHandler } from './clear.js';
import { createQueueHandler } from './submit.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

describe('clear', () => {
  it('removes pending messages from live state and emits queue_cleared', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeStateWithQueue([
      makeMessage('pending'),
      { ...makeMessage('drained'), id: 'msg-drained', drainedAt: new Date().toISOString() },
    ]);
    const { bus, events } = makeBusRecorder();
    const serialize = createWriteSequencer();

    const clear = createClearQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
      serialize,
    });

    const result = await clear();

    expect(result).toEqual({ status: 'cleared', count: 1 });
    expect(state?.messageQueue).toEqual([
      expect.objectContaining({ id: 'msg-drained', text: 'drained' }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'queue_cleared',
        count: 1,
        phase: state?.phase,
      }),
    );
  });

  it('does not remove messages already delivered through native injection', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = {
      ...makeResearchingState(),
      messageQueue: [
        makeMessage('pending'),
        { ...makeMessage('injecting'), id: 'msg-injecting', nativeDeliveryState: 'injecting' },
        { ...makeMessage('native delivered'), id: 'msg-native', deliveredViaNative: true },
        { ...makeMessage('drained'), id: 'msg-drained', drainedAt: new Date().toISOString() },
      ],
    };
    const { bus } = makeBusRecorder();
    const serialize = createWriteSequencer();

    const clear = createClearQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
      serialize,
    });

    expect(await clear()).toEqual({ status: 'cleared', count: 2 });
    expect(state?.messageQueue.map((message) => message.id)).toEqual(['msg-native', 'msg-drained']);
  });

  it('clears pending messages from persisted state when caller state is stale', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeResearchingState();
    saveState(
      { projectDir, sessionId },
      makeStateWithQueue([
        makeMessage('persisted pending'),
        {
          ...makeMessage('persisted drained'),
          id: 'msg-drained',
          drainedAt: new Date().toISOString(),
        },
      ]),
    );
    const { bus } = makeBusRecorder();
    const serialize = createWriteSequencer();

    const clear = createClearQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
      serialize,
    });

    const result = await clear();

    expect(result).toEqual({ status: 'cleared', count: 1 });
    expect(state?.messageQueue).toEqual([
      expect.objectContaining({ id: 'msg-drained', text: 'persisted drained' }),
    ]);
  });

  it('serializes clear with enqueue so cleared messages cannot be resurrected', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    let state: WorkflowState | undefined = makeStateWithQueue([makeMessage('old')]);
    const { bus } = makeBusRecorder();
    const planner = makePlanner();
    const inner = createWriteSequencer();
    let releaseClear: (() => void) | undefined;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    let clearEntered = false;
    const serialize: typeof inner = (fn) =>
      inner(async () => {
        if (!clearEntered) {
          clearEntered = true;
          await clearGate;
        }
        return fn();
      });

    const enqueue = createQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
      persistTranscript: false,
      planner,
      serialize,
    });
    const clear = createClearQueueHandler({
      projectDir,
      sessionId,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      bus,
      serialize,
    });

    const clearPromise = clear();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const enqueuePromise = enqueue('after-clear', 'researching');
    releaseClear?.();
    await Promise.all([clearPromise, enqueuePromise]);

    expect(state?.messageQueue.map((message) => message.text)).toEqual(['after-clear']);
    expect(
      loadState({ projectDir, sessionId })?.messageQueue.map((message) => message.text),
    ).toEqual(['after-clear']);
  });
});
