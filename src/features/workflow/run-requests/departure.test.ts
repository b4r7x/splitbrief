import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { STATE_FILE, sessionDir } from '../../../core/paths.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import {
  activeApply,
  trackActiveApply,
} from '../../../engine/orchestrator/session-lifecycle/shutdown.js';
import { clearAllHandlers, createAbortHandlerScope, setStopHandler } from './registry.js';
import { requestQuit, requestLeaveSession } from './departure.js';
import { requestStopNow } from './stop-resume.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { eventsStore } from '../../../stores/workflow/events/state.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import {
  __testDiscardPending,
  draftRefusalStore,
  loadSessionDraft,
  saveSessionDraft,
} from '../../../stores/ui/session-drafts.js';
import { markCancellationRequested } from '../../../stores/workflow/actions/interrupt.js';
import { loadEvents } from '../../../stores/workflow/actions/load.js';
import { createDraftDocument } from '../../../core/composer/document.js';
import { writeSessionDraft } from '../../../core/sessions/draft.js';
import { installDiagnosticSink } from '../../../lib/warn.js';

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
  let releaseSink: () => void;
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
    releaseSink = installDiagnosticSink(() => {});
  });
  afterEach(() => {
    releaseSink();
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
  const HINT = {
    message: 'Draft not saved · esc or quit again leaves without it',
    severity: 'error',
  };

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
      severity: 'error',
    });

    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('leaving with an empty composer over an old draft that cannot be removed', () => {
  let projectDir: string;
  let dir: string;
  const ref = () => ({ projectDir, sessionId: 'one' });
  const NOTE =
    'Could not remove the old draft: permission denied · .splitbrief/sessions/one/draft.json · its text comes back when you restart SPLITBRIEF and open that run';
  let diagnostics: { message: string; presentation: string }[];
  let releaseSink: () => void;

  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
    projectDir = createTempDir('handlers-draft-unremovable-');
    dir = sessionDir(projectDir, 'one');
    writeSessionDraft(ref(), createDraftDocument('my unsent draft'));
    chmodSync(dir, 0o555);
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: ref() }),
      execution: { kind: 'at-rest' },
    });
    saveSessionDraft(ref(), createDraftDocument(''));
    diagnostics = [];
    releaseSink = installDiagnosticSink((message, presentation) =>
      diagnostics.push({ message, presentation }),
    );
  });
  afterEach(() => {
    releaseSink();
    chmodSync(dir, 0o755);
    __testDiscardPending();
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
    routerStore.reset();
    cleanupTempDir(projectDir);
  });

  it.each([
    [
      'esc, Back to sessions',
      () => {
        requestLeaveSession();
        return routerStore.get().screen === 'home';
      },
    ],
    [
      'ctrl+c, /quit',
      () => {
        const exit = vi.fn();
        requestQuit(exit);
        return exit.mock.calls.length === 1;
      },
    ],
  ])('%s leaves on the first press', (_name, leave) => {
    expect(leave()).toBe(true);
    expect(draftRefusalStore.get()).toBeNull();
    expect(feedbackStore.get().message ?? '').not.toContain('Draft not saved');
  });

  it('names the file on home after esc', () => {
    requestLeaveSession();
    expect(routerStore.get().screen).toBe('home');
    expect(feedbackStore.get()).toEqual({ message: NOTE, severity: 'error' });
  });

  it('names the file on stderr once the terminal is restored after a quit', () => {
    const exit = vi.fn();
    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([
      { message: NOTE, presentation: 'at-exit' },
      { message: 'Continue this run with: splitbrief continue one', presentation: 'at-exit' },
    ]);
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
  let diagnostics: { message: string; presentation: string }[];
  let releaseSink: () => void;

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
    diagnostics = [];
    releaseSink = installDiagnosticSink((message, presentation) =>
      diagnostics.push({ message, presentation }),
    );
  });

  afterEach(async () => {
    await settle(readyState());
    releaseSink();
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
    expect(diagnostics).toEqual([]);

    await settle(readyState());
    expect(exit).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([
      {
        message: 'Continue this run with: splitbrief continue applying-run',
        presentation: 'at-exit',
      },
    ]);
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

describe('a quit names the command that continues the run', () => {
  const sessionId = 'resumable-run';
  let projectDir: string;
  let diagnostics: { message: string; presentation: string }[];
  let releaseSink: () => void;

  function saveState(state: WorkflowState): void {
    writeFileSync(join(sessionDir(projectDir, sessionId), STATE_FILE), JSON.stringify(state));
  }

  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
    projectDir = createTempDir('handlers-quit-continue-');
    mkdirSync(sessionDir(projectDir, sessionId), { recursive: true });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: { projectDir, sessionId } }),
      execution: { kind: 'at-rest' },
    });
    diagnostics = [];
    releaseSink = installDiagnosticSink((message, presentation) =>
      diagnostics.push({ message, presentation }),
    );
  });

  afterEach(() => {
    releaseSink();
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
    routerStore.reset();
    cleanupTempDir(projectDir);
  });

  it.each([
    [
      'stopped',
      makeWorkflowState({
        phase: 'implementing',
        interruptedStep: {
          step: { kind: 'review', cycle: 0 },
          source: 'user',
          cut: 'boundary',
          at: '2026-10-19T00:00:00.000Z',
        },
      }),
    ],
    [
      'halted',
      makeWorkflowState({
        phase: 'implementing',
        pendingRecovery: makeRecoveryIssue(),
      }),
    ],
    [
      'waiting for an answer',
      makeWorkflowState({
        phase: 'planning',
        pendingPlannerConversation: {
          call: 'plan',
          text: 'Which DB?',
          questions: [],
          answers: [],
          answered: false,
        },
      }),
    ],
    [
      'ready to apply',
      makeWorkflowState({
        phase: 'complete',
        reviewStatus: 'passed',
        workspace: {
          kind: 'staged-copy',
          path: '/tmp/run-workspace',
          base: { snapshotId: 'workspace-base', head: null },
        },
      }),
    ],
  ] as const)('names the continue command on stderr after a quit from a %s run', (_name, state) => {
    saveState(state);
    const exit = vi.fn();
    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([
      {
        message: `Continue this run with: splitbrief continue ${sessionId}`,
        presentation: 'at-exit',
      },
    ]);
  });

  it('writes no continue line after a quit from a closed run', () => {
    for (const as of ['applied', 'ended'] as const) {
      diagnostics = [];
      saveState(
        makeWorkflowState({
          closed: { at: '2026-10-19T00:00:00.000Z', as },
        }),
      );
      const exit = vi.fn();
      requestQuit(exit);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(diagnostics).toEqual([]);
    }
  });

  it('writes no continue line after a quit from home', () => {
    routerStore.navigate({ to: 'home' });
    const exit = vi.fn();
    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([]);
  });

  it('quits immediately without a continue line after the observed owner stops', () => {
    const route = routerStore.get();
    if (route.screen !== 'workflow') throw new Error('Expected the workflow screen.');
    routerStore.updateRun({ run: route.run, execution: { kind: 'at-rest', observing: true } });
    saveState(makeWorkflowState({ phase: 'implementing' }));
    const exit = vi.fn();

    requestQuit(exit);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([]);
  });

  it('names an old draft before the continue line', () => {
    const dir = sessionDir(projectDir, sessionId);
    writeSessionDraft({ projectDir, sessionId }, createDraftDocument('my unsent draft'));
    chmodSync(dir, 0o555);
    try {
      saveSessionDraft({ projectDir, sessionId }, createDraftDocument(''));
      const exit = vi.fn();
      requestQuit(exit);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(diagnostics).toEqual([
        {
          message: `Could not remove the old draft: permission denied · .splitbrief/sessions/${sessionId}/draft.json · its text comes back when you restart SPLITBRIEF and open that run`,
          presentation: 'at-exit',
        },
        {
          message: `Continue this run with: splitbrief continue ${sessionId}`,
          presentation: 'at-exit',
        },
      ]);
    } finally {
      chmodSync(dir, 0o755);
      __testDiscardPending();
    }
  });
});
