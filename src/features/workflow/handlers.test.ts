import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainUserMessage } from '../../core/types/user-input.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { STATE_FILE, sessionDir } from '../../core/paths.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import {
  activeApply,
  trackActiveApply,
} from '../../engine/orchestrator/session-lifecycle/shutdown.js';
import {
  abortTurn,
  cancelBoundaryPause,
  clearAllHandlers,
  consumeBoundaryInterrupt,
  consumeBoundaryPause,
  createAbortHandlerScope,
  landBoundaryPause,
  requestBoundaryPause,
  requestEndRun,
  requestQuit,
  requestLeaveSession,
  setStopHandler,
  requestResume,
  requestSeatChangeAtBoundary,
  requestSteer,
  requestStopNow,
  requestClearQueue,
  resumeParkedRun,
  setCancelHandler,
  setClearQueueHandler,
  setResumeHandler,
  spendSeatChange,
} from './handlers.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { routerStore } from '../../stores/navigation/router.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { stopStore } from '../../stores/workflow/stop.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import {
  __testDiscardPending,
  draftRefusalStore,
  loadSessionDraft,
  saveSessionDraft,
} from '../../stores/ui/session-drafts.js';
import { markCancellationRequested } from '../../stores/workflow/actions/interrupt.js';
import { loadEvents } from '../../stores/workflow/actions/load.js';
import { createDraftDocument } from '../../core/composer/document.js';

describe('createAbortHandlerScope', () => {
  afterEach(() => {
    clearAllHandlers();
  });

  it('abort handlers stack LIFO within a scope', () => {
    const setAbortHandler = createAbortHandlerScope();
    const outer = vi.fn();
    const inner = vi.fn();
    setAbortHandler(outer);
    setAbortHandler(inner);

    expect(abortTurn()).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    setAbortHandler(null);
    expect(abortTurn()).toBe(true);
    expect(outer).toHaveBeenCalledTimes(1);

    setAbortHandler(null);
    expect(abortTurn()).toBe(false);
  });

  it("a superseded scope's late pop cannot steal the next scope's handler", () => {
    const oldScope = createAbortHandlerScope();
    const oldHandler = vi.fn();
    oldScope(oldHandler);

    // Rewind: cleanup clears everything, then the next run opens its own scope
    // while the old run's aborted body is still settling.
    clearAllHandlers();
    const newScope = createAbortHandlerScope();
    const newHandler = vi.fn();
    newScope(newHandler);

    // The old body finally settles and issues its paired pop.
    oldScope(null);

    expect(abortTurn()).toBe(true);
    expect(newHandler).toHaveBeenCalledTimes(1);
    expect(oldHandler).not.toHaveBeenCalled();
  });
});

describe('requestStopNow', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    lifecycleStore.reset();
    eventsStore.reset();
    lifecycleStore.__testReset({ phase: 'planning' });
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('stop now aborts an escalation call', () => {
    const abortEscalation = vi.fn();
    createAbortHandlerScope()(abortEscalation);

    expect(requestStopNow()).toBe(true);
    expect(abortEscalation).toHaveBeenCalledTimes(1);
    expect(stopStore.get()).toMatchObject({ intent: 'stop-now', phase: 'requested' });
    expect(lifecycleStore.get().cancelled).toBe(false);
  });

  it('flags the next boundary when no call is in flight', () => {
    const cancel = vi.fn();
    setCancelHandler(cancel);

    expect(requestStopNow()).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(consumeBoundaryInterrupt()).toBe(true);
  });

  it('announces no stop when there is nothing to stop', () => {
    expect(requestStopNow()).toBe(false);
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle' });
  });
});

describe('requestBoundaryPause', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('hands the engine one pause and clears it on the way out', () => {
    requestBoundaryPause();

    expect(stopStore.get().intent).toBe('pause-after-brief');
    expect(consumeBoundaryPause()).toBe(true);
    expect(consumeBoundaryPause()).toBe(false);
  });

  it('keeps running drops the pending pause', () => {
    requestBoundaryPause();
    cancelBoundaryPause();

    expect(consumeBoundaryPause()).toBe(false);
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle' });
  });

  it('a seat change asks the engine for the boundary and arms no pause of the operator', () => {
    requestSeatChangeAtBoundary();

    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle', seatChange: true });
    expect(consumeBoundaryPause()).toBe(true);
  });

  it('spending a seat change leaves no boundary to stop at', () => {
    requestSeatChangeAtBoundary();
    spendSeatChange();

    expect(consumeBoundaryPause()).toBe(false);
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle', seatChange: false });
  });

  it('spending a seat change keeps the pause the operator asked for', () => {
    requestBoundaryPause();
    requestSeatChangeAtBoundary();
    spendSeatChange();

    expect(stopStore.get().intent).toBe('pause-after-brief');
    expect(consumeBoundaryPause()).toBe(true);
    expect(landBoundaryPause()).toBe('park');
  });

  it('keep running withdraws only the operator pause, and the seat change still waits', () => {
    requestBoundaryPause();
    requestSeatChangeAtBoundary();
    cancelBoundaryPause();

    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle', seatChange: true });
    expect(landBoundaryPause()).toBe('continue');
  });

  it('lands the boundary pause as a park, a continue on the saved seats, or a stop the operator asked for', () => {
    requestBoundaryPause();
    expect(landBoundaryPause()).toBe('park');

    stopStore.__testReset();
    requestSeatChangeAtBoundary();
    expect(landBoundaryPause()).toBe('continue');
    expect(stopStore.get().seatChange).toBe(false);

    requestBoundaryPause();
    requestSeatChangeAtBoundary();
    expect(landBoundaryPause()).toBe('stop');
    expect(stopStore.get()).toMatchObject({ intent: 'pause-after-brief', seatChange: false });
  });
});

describe('requestEndRun', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    lifecycleStore.reset();
    eventsStore.reset();
    lifecycleStore.__testReset({ phase: 'planning' });
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('cancels the run and records the intent', () => {
    const cancel = vi.fn();
    setCancelHandler(cancel);

    expect(requestEndRun()).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(lifecycleStore.get().cancelled).toBe(true);
    expect(stopStore.get().intent).toBe('end-run');
  });
});

describe('requestResume', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('hands every continuation to the run, park or no park', () => {
    const resume = vi.fn();
    const steer = vi.fn();
    setResumeHandler(resume);
    stopStore.park('mid-brief', 'T002', steer);

    expect(requestResume(plainUserMessage('use the other adapter'))).toBe(true);
    expect(resume).toHaveBeenCalledWith(plainUserMessage('use the other adapter'));
    // The run decides what continuing means; nothing settles behind its back.
    expect(steer).not.toHaveBeenCalled();
  });

  it('reports nothing to resume when no run is on screen', () => {
    expect(requestResume(plainUserMessage(''))).toBe(false);
  });
});

describe('resumeParkedRun', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('settles a parked brief with the typed steer', () => {
    const steer = vi.fn();
    stopStore.park('mid-brief', 'T002', steer);

    expect(resumeParkedRun(plainUserMessage('use the other adapter'))).toBe(true);
    expect(steer).toHaveBeenCalledWith(plainUserMessage('use the other adapter'));
    expect(stopStore.get().phase).toBe('idle');
  });

  it('settles a boundary park so the run starts the next brief', () => {
    const steer = vi.fn();
    stopStore.request('pause-after-brief');
    stopStore.park('boundary', 'T001', steer);

    expect(resumeParkedRun(plainUserMessage(''))).toBe(true);
    expect(steer).toHaveBeenCalledWith(plainUserMessage(''));
  });

  it('reports no park when the run is at rest', () => {
    expect(resumeParkedRun(plainUserMessage(''))).toBe(false);
  });

  it('leaves a resolverless park for the saved-state continuation', () => {
    stopStore.park('mid-brief', 'T001', null);

    expect(resumeParkedRun(plainUserMessage('keep the greeting API'))).toBe(false);
    expect(stopStore.get().phase).toBe('parked');
  });
});

describe('requestSteer', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('stops now and holds the text until the park lands', () => {
    const stop = vi.fn();
    setStopHandler(stop);

    expect(requestSteer(plainUserMessage('smaller diffs'))).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);

    // The text survives the stop race: the park that follows resumes with it.
    const steer = vi.fn();
    stopStore.park('mid-brief', 'T002', steer);
    expect(steer).toHaveBeenCalledWith(plainUserMessage('smaller diffs'));
  });

  it('continues a run already parked with the text', () => {
    const steer = vi.fn();
    stopStore.park('mid-brief', 'T002', steer);

    expect(requestSteer(plainUserMessage('use the other adapter'))).toBe(true);
    expect(steer).toHaveBeenCalledWith(plainUserMessage('use the other adapter'));
  });

  it('reports nothing to steer when no run is on screen', () => {
    expect(requestSteer(plainUserMessage('nope'))).toBe(false);
  });

  it('hands a resolverless park to the run continuation with its attachments', () => {
    const resume = vi.fn();
    setResumeHandler(resume);
    stopStore.park('mid-brief', 'T001', null);
    const message = {
      ...plainUserMessage('keep the greeting API'),
      attachedInputs: [{ path: '/tmp/send-now-note.md', kind: 'text' as const }],
    };

    expect(requestSteer(message)).toBe(true);
    expect(resume).toHaveBeenCalledExactlyOnceWith(message);
  });

  it.each([
    ['stop', requestStopNow],
    ['end run', requestEndRun],
  ] as const)('an explicit %s supersedes a pending steer', (_name, stop) => {
    lifecycleStore.__testReset({ phase: 'implementing', cancelled: false });
    setStopHandler(vi.fn());
    setCancelHandler(vi.fn());
    createAbortHandlerScope()(vi.fn());
    expect(requestSteer(plainUserMessage('keep the greeting API'))).toBe(true);

    expect(stop()).toBe(true);
    const resolve = vi.fn();
    stopStore.park('mid-brief', 'T001', resolve);

    expect(resolve).not.toHaveBeenCalled();
    expect(stopStore.get().phase).toBe('parked');
  });

  it('delivers the steer exactly once when the stop parks synchronously', () => {
    const resolve = vi.fn();
    setStopHandler(() => stopStore.park('mid-brief', 'T001', resolve));
    const message = plainUserMessage('keep the greeting API');

    expect(requestSteer(message)).toBe(true);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(message);
    expect(stopStore.get().phase).toBe('idle');
  });
});

describe('requestQuit', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('exits at once when there is no run to stop', () => {
    const exit = vi.fn();

    requestQuit(exit);

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('waits for the run to park before leaving', () => {
    const exit = vi.fn();
    createAbortHandlerScope()(vi.fn());

    requestQuit(exit);
    expect(exit).not.toHaveBeenCalled();

    stopStore.park('mid-brief', 'T002', null);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('departure with an unsent draft that cannot be saved', () => {
  let projectDir: string;
  let dir: string;
  const run = () => makeRunRecord({ ref: ref() });
  const openRun = () =>
    routerStore.init({ screen: 'workflow', run: run(), execution: { kind: 'at-rest' } });
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
    eventsStore.reset();
    lifecycleStore.reset();
    projectDir = createTempDir('handlers-draft-');
    dir = sessionDir(projectDir, 'one');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    openRun();
  });
  afterEach(() => {
    chmodSync(dir, 0o755);
    __testDiscardPending();
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
    routerStore.reset();
    cleanupTempDir(projectDir);
  });

  const ref = () => ({ projectDir, sessionId: 'one' });
  const CAUSE = 'Draft not saved: permission denied · .splitbrief/sessions/one/draft.json';
  const HINT = { message: 'Draft not saved · esc or quit again leaves without it', isError: true };

  it('names the cause and the file once, then leaves without it on the next quit', () => {
    const exit = vi.fn();
    saveSessionDraft(ref(), createDraftDocument('unsent words'));

    requestQuit(exit);
    expect(exit).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toEqual(HINT);
    expect(draftRefusalStore.get()?.message).toBe(CAUSE);
    expect(eventsStore.get().events).toEqual([]);

    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(loadSessionDraft(ref())).toEqual(createDraftDocument(''));
    expect(draftRefusalStore.get()).toBeNull();
  });

  it('holds a later leave again once a save in between landed', () => {
    const exit = vi.fn();
    saveSessionDraft(ref(), createDraftDocument('first words'));
    requestQuit(exit);
    chmodSync(dir, 0o755);
    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);

    chmodSync(dir, 0o555);
    feedbackStore.reset();
    saveSessionDraft(ref(), createDraftDocument('second words'));
    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(feedbackStore.get()).toEqual(HINT);
  });

  it('leaves on the second quit after a re-read of the same run replaced its route', () => {
    const exit = vi.fn();
    saveSessionDraft(ref(), createDraftDocument('unsent words'));
    requestQuit(exit);
    routerStore.updateRun({ run: run(), execution: { kind: 'at-rest' } });

    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('holds again when the same run is opened again before the next quit', () => {
    const exit = vi.fn();
    saveSessionDraft(ref(), createDraftDocument('unsent words'));
    requestQuit(exit);
    routerStore.navigate({ to: 'home' });
    routerStore.navigate({ to: 'workflow', run: run(), execution: { kind: 'at-rest' } });

    requestQuit(exit);
    expect(exit).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toEqual(HINT);
  });

  it('keeps the cause and the file after End run when the at-rest re-read replaces the log', () => {
    const exit = vi.fn();
    saveSessionDraft(ref(), createDraftDocument('unsent words'));
    markCancellationRequested();
    requestQuit(exit);
    loadEvents([]);

    expect(exit).not.toHaveBeenCalled();
    expect(draftRefusalStore.get()?.message).toBe(CAUSE);
  });

  it('names the cause and the file on home and says a second quit leaves without it', () => {
    const exit = vi.fn();
    saveSessionDraft(ref(), createDraftDocument('unsent words'));
    routerStore.navigate({ to: 'home' });

    requestQuit(exit);
    expect(exit).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toEqual({
      message: `${CAUSE} · quit again leaves without it`,
      isError: true,
    });

    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('consumeBoundaryInterrupt', () => {
  beforeEach(() => {
    clearAllHandlers();
    lifecycleStore.reset();
    lifecycleStore.__testReset({ phase: 'planning' });
  });

  afterEach(() => {
    clearAllHandlers();
  });

  it('consumeBoundaryInterrupt reads and clears the pending flag', () => {
    expect(consumeBoundaryInterrupt()).toBe(false);

    setCancelHandler(vi.fn());
    requestStopNow();

    expect(consumeBoundaryInterrupt()).toBe(true);
    expect(consumeBoundaryInterrupt()).toBe(false);
  });
});

describe('requestClearQueue', () => {
  beforeEach(() => {
    clearAllHandlers();
    lifecycleStore.reset();
    eventsStore.reset();
    lifecycleStore.__testReset({ phase: 'planning', queueDepth: 2 });
  });

  afterEach(() => {
    clearAllHandlers();
  });

  it('returns unavailable and does not mutate lifecycle or events when no handler exists', () => {
    expect(requestClearQueue()).toEqual({
      status: 'unavailable',
      message: 'Queue clear is not available for this workflow.',
    });
    expect(lifecycleStore.get().queueDepth).toBe(2);
    expect(eventsStore.get().events).toEqual([]);
  });

  it('delegates to the registered clear handler', () => {
    const clear = vi.fn(() => ({ status: 'cleared' as const, count: 2 }));
    setClearQueueHandler(clear);

    expect(requestClearQueue()).toEqual({ status: 'cleared', count: 2 });
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe('safe departure', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.reset();
    routerStore.reset();
  });
  afterEach(() => {
    clearAllHandlers();
    stopStore.reset();
    routerStore.reset();
  });

  it('observes a synchronous stop and invokes exit exactly once', () => {
    const stop = vi.fn(() => stopStore.park('mid-brief', null, null));
    setStopHandler(stop);
    const exit = vi.fn();
    requestQuit(exit);
    stopStore.end();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('keeps one stop request while quit supersedes pending home', () => {
    const stop = vi.fn();
    setStopHandler(stop);
    const exit = vi.fn();
    const home = vi.spyOn(routerStore, 'navigate');
    requestStopNow();
    const requestedAt = stopStore.get().requestedAt;
    requestLeaveSession();
    requestQuit(exit);
    requestQuit(exit);
    requestLeaveSession();
    expect(exit).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopStore.get().requestedAt).toBe(requestedAt);
    stopStore.park('mid-brief', null, null);
    expect(home).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    home.mockRestore();
  });

  it('unwinds a boundary promise before delivering exit', () => {
    stopStore.request('pause-after-brief');
    const resolve = vi.fn();
    stopStore.park('boundary', 'T001', resolve);
    const stop = vi.fn(() => stopStore.get().parked?.resolve?.(plainUserMessage('')));
    setStopHandler(stop);
    const exit = vi.fn();
    requestQuit(exit);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    stopStore.park('boundary', 'T001', null);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('cancels departure on a failed save and retries the original explicit end intent', () => {
    const stop = vi.fn();
    setStopHandler(stop);
    stopStore.request('end-run');
    const exit = vi.fn();
    requestQuit(exit);
    stopStore.fail('Disk full');
    expect(exit).not.toHaveBeenCalled();
    expect(requestStopNow()).toBe(true);
    expect(stopStore.get()).toMatchObject({ intent: 'end-run', phase: 'requested' });
    expect(stopStore.get().error).toBeUndefined();
    stopStore.end();
    expect(exit).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not deliver stale departure after changing sessions', () => {
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: { projectDir: '/tmp', sessionId: 'first' } }),
      execution: { kind: 'at-rest' },
    });
    setStopHandler(vi.fn());
    const exit = vi.fn();
    requestQuit(exit);
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: { projectDir: '/tmp', sessionId: 'second' } }),
      execution: { kind: 'at-rest' },
    });
    stopStore.park('mid-brief', null, null);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('departure while this process applies the run at rest', () => {
  const sessionId = 'applying-run';
  const at = '2026-10-19T00:00:00.000Z';
  let projectDir = '';
  let settle: (state: WorkflowState) => Promise<void> = async () => {};

  const readyState = (): WorkflowState =>
    makeWorkflowState({
      phase: 'complete',
      reviewStatus: 'passed',
      workspace: {
        kind: 'staged-copy',
        path: '/tmp/run-workspace',
        base: { snapshotId: 'workspace-base', head: null },
      },
    });
  const appliedState = (): WorkflowState => ({
    ...readyState(),
    applied: { at, backupId: 'backup-1', files: ['a.txt'] },
    closed: { at, as: 'applied' },
  });

  function saveState(state: WorkflowState): void {
    writeFileSync(join(sessionDir(projectDir, sessionId), STATE_FILE), JSON.stringify(state));
  }

  beforeEach(() => {
    clearAllHandlers();
    stopStore.reset();
    projectDir = createTempDir('handlers-apply');
    mkdirSync(sessionDir(projectDir, sessionId), { recursive: true });
    saveState(readyState());
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: { projectDir, sessionId }, status: { kind: 'running' } }),
      execution: { kind: 'at-rest' },
    });
    const apply = Promise.withResolvers<void>();
    void trackActiveApply(apply.promise);
    settle = async (state) => {
      saveState(state);
      apply.resolve();
      await activeApply();
      await new Promise((resolve) => setImmediate(resolve));
    };
  });

  afterEach(async () => {
    await settle(readyState());
    clearAllHandlers();
    stopStore.reset();
    routerStore.reset();
    cleanupTempDir(projectDir);
  });

  it('queues a quit until the Apply settles, then quits once', async () => {
    const exit = vi.fn();

    requestQuit(exit);
    requestQuit(exit);
    expect(exit).not.toHaveBeenCalled();

    await settle(readyState());
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('goes home once the Apply settles with the run applied', async () => {
    requestLeaveSession();
    requestLeaveSession();
    expect(routerStore.get().screen).toBe('workflow');

    await settle(appliedState());
    expect(routerStore.get().screen).toBe('home');
  });

  it('drops a queued home and stays on the run when the Apply did not apply it', async () => {
    requestLeaveSession();

    await settle(readyState());
    expect(routerStore.get().screen).toBe('workflow');
  });

  it('lets a quit replace a queued home, and a later Esc changes nothing', async () => {
    const exit = vi.fn();

    requestLeaveSession();
    requestQuit(exit);
    requestLeaveSession();
    expect(exit).not.toHaveBeenCalled();

    await settle(readyState());
    expect(exit).toHaveBeenCalledTimes(1);
    expect(routerStore.get().screen).toBe('workflow');
  });

  it('keeps a home queued behind the Apply when the run loop that drove it tears down', async () => {
    requestLeaveSession();
    clearAllHandlers();

    await settle(appliedState());
    expect(routerStore.get().screen).toBe('home');
  });
});
