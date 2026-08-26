import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeResumeAuthorityDeps } from '#testing/helpers/factories/state-authority.js';
import { createInitialState } from '../../core/state/machine.js';
import { readActive, reactivateExistingSession } from '../../core/sessions/active-pointer.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type {
  PreparationOutcome,
  PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import { parsePreparedConfig } from '../../engine/runners/prepared-execution.js';
import { overlayStore } from '../ui/overlay.js';
import { routerStore } from './router.js';
import {
  cancelSessionPreparation,
  handleSessionSelect,
  sessionSelectStore,
  type SessionSelectDeps,
} from './session-select.js';

let tmp: string;

function preparedResumeExecution(
  projectDir: string,
  sessionId: string,
  resumeState: WorkflowState,
): PreparedExecution {
  const active = {
    version: 1 as const,
    sessionId,
    generation: '22222222-2222-4222-8222-222222222222',
  };
  return {
    purpose: 'resume',
    config: parsePreparedConfig(makeConfig()),
    preparationId: 'session-select-preparation',
    report: {
      generatedAt: '2026-08-04T00:00:00.000Z',
      projectDir,
      status: 'ready',
      counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
      sections: [],
      metadata: {},
    },
    gates: [],
    session: {
      kind: 'existing',
      ref: { projectDir, sessionId },
      active,
    },
    runtime: {
      feature: resumeState.feature,
      resumeState,
      allowRepoRunners: false,
      allowHooks: false,
    },
  };
}

function sessionSelectDeps(overrides: Partial<SessionSelectDeps> = {}): SessionSelectDeps {
  return {
    ...makeResumeAuthorityDeps((ref) => loadState(ref)),
    prepareResume: async () => {
      throw new Error('Resume preparation was not expected');
    },
    ...overrides,
  };
}

beforeEach(() => {
  tmp = createTempDir('session-select-test');
  overlayStore.reset();
  routerStore.reset();
  sessionSelectStore.reset();
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  overlayStore.reset();
  routerStore.reset();
  sessionSelectStore.reset();
});

describe('handleSessionSelect (Enter routing)', () => {
  it('recent session resume prepares the existing session before local navigation', async () => {
    overlayStore.open('sessions');
    const session = makeSession({
      id: 'sess-resume',
      feature: 'add auth',
      status: 'interrupted',
      summary: null,
    });
    const savedState = { ...createInitialState('saved add auth'), phase: 'implementing' as const };
    saveState({ projectDir: tmp, sessionId: session.id }, savedState);
    const prepared = preparedResumeExecution(tmp, session.id, savedState);
    let resolvePreparation: ((outcome: PreparationOutcome) => void) | undefined;
    const pendingPreparation = new Promise<PreparationOutcome>((resolve) => {
      resolvePreparation = resolve;
    });
    const deps = sessionSelectDeps({
      ...makeResumeAuthorityDeps(() => savedState),
      prepareResume: async ({ ref, state }) => {
        expect(ref).toEqual({ projectDir: tmp, sessionId: session.id });
        expect(state).toBe(savedState);
        return pendingPreparation;
      },
    });

    const selection = handleSessionSelect(session, tmp, deps);

    expect(overlayStore.get().active).toBe('none');
    expect(sessionSelectStore.get().preparation.kind).toBe('preparing');
    expect(routerStore.get().screen).toBe('home');
    if (resolvePreparation === undefined) throw new Error('Preparation did not start');
    resolvePreparation({ kind: 'prepared', execution: prepared });
    await selection;

    expect(overlayStore.get().active).toBe('none');
    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.execution.kind).toBe('local');
      if (route.execution.kind === 'local') {
        expect(route.execution.prepared).toBe(prepared);
        expect(route.execution.prepared.runtime.feature).toBe('saved add auth');
        expect(route.execution.prepared.runtime.resumeState).toEqual(savedState);
        expect(route.execution.prepared.session.ref.sessionId).toBe(session.id);
      }
    }
    expect(sessionSelectStore.get().error).toBeNull();
  });

  it('refuses to replace an active local workflow before resume preparation starts', async () => {
    const currentState = {
      ...createInitialState('current local workflow'),
      phase: 'implementing' as const,
    };
    const currentPrepared = preparedResumeExecution(tmp, 'current-local', currentState);
    routerStore.navigate({
      to: 'workflow',
      execution: { kind: 'local', prepared: currentPrepared },
    });
    const exactRoute = routerStore.get();
    overlayStore.open('sessions');
    const selected = makeSession({
      id: 'resume-other',
      feature: 'resume another session',
      status: 'interrupted',
      summary: null,
    });
    const selectedState = {
      ...createInitialState(selected.feature),
      phase: 'implementing' as const,
    };
    const prepareResume = vi.fn<SessionSelectDeps['prepareResume']>();

    await handleSessionSelect(
      selected,
      tmp,
      sessionSelectDeps({ ...makeResumeAuthorityDeps(() => selectedState), prepareResume }),
    );

    expect(prepareResume).not.toHaveBeenCalled();
    expect(routerStore.get()).toBe(exactRoute);
    expect(exactRoute.screen).toBe('workflow');
    if (exactRoute.screen === 'workflow' && exactRoute.execution.kind === 'local') {
      expect(exactRoute.execution.prepared).toBe(currentPrepared);
    }
    expect(overlayStore.get().active).toBe('sessions');
    expect(sessionSelectStore.get().preparation.kind).toBe('idle');
    expect(sessionSelectStore.get().error).toContain('current local workflow');
  });

  it('still permits an attached workflow to hand off to a prepared local resume', async () => {
    routerStore.navigate({
      to: 'workflow',
      execution: {
        kind: 'attached',
        feature: 'attached workflow',
        sessionId: 'attached-current',
        attach: { sockPath: '/tmp/attached.sock', authToken: 'token' },
      },
    });
    overlayStore.open('sessions');
    const selected = makeSession({
      id: 'resume-from-attached',
      feature: 'resume from attached',
      status: 'interrupted',
      summary: null,
    });
    const selectedState = {
      ...createInitialState(selected.feature),
      phase: 'implementing' as const,
    };
    const prepared = preparedResumeExecution(tmp, selected.id, selectedState);
    const prepareResume = vi.fn<SessionSelectDeps['prepareResume']>(async () => ({
      kind: 'prepared',
      execution: prepared,
    }));

    await handleSessionSelect(
      selected,
      tmp,
      sessionSelectDeps({ ...makeResumeAuthorityDeps(() => selectedState), prepareResume }),
    );

    expect(prepareResume).toHaveBeenCalledOnce();
    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow' && route.execution.kind === 'local') {
      expect(route.execution.prepared).toBe(prepared);
    }
  });

  it('single-flights duplicate resume selections', async () => {
    const session = makeSession({
      id: 'sess-duplicate',
      feature: 'resume once',
      status: 'interrupted',
      summary: null,
    });
    const savedState = { ...createInitialState('resume once'), phase: 'implementing' as const };
    const pending = Promise.withResolvers<PreparationOutcome>();
    const signals: AbortSignal[] = [];
    const prepareResume = vi.fn((_input, signal: AbortSignal) => {
      signals.push(signal);
      return pending.promise;
    });
    const deps = sessionSelectDeps({ ...makeResumeAuthorityDeps(() => savedState), prepareResume });

    const first = handleSessionSelect(session, tmp, deps);
    const duplicate = handleSessionSelect(session, tmp, deps);
    await Promise.resolve();

    expect(prepareResume).toHaveBeenCalledOnce();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    pending.resolve({
      kind: 'blocked',
      report: preparedResumeExecution(tmp, session.id, savedState).report,
    });
    await Promise.all([first, duplicate]);
    expect(sessionSelectStore.get().preparation.kind).toBe('blocked');
  });

  it('cancels the caller-owned signal and exact-clears a late existing-session receipt', async () => {
    overlayStore.open('sessions');
    const session = makeSession({
      id: 'sess-cancelled',
      feature: 'cancel resume',
      status: 'interrupted',
      summary: null,
    });
    const savedState = { ...createInitialState('cancel resume'), phase: 'implementing' as const };
    const pending = Promise.withResolvers<PreparationOutcome>();
    let signal: AbortSignal | undefined;
    const selection = handleSessionSelect(
      session,
      tmp,
      sessionSelectDeps({
        ...makeResumeAuthorityDeps(() => savedState),
        prepareResume: (_input, attemptSignal) => {
          signal = attemptSignal;
          return pending.promise;
        },
      }),
    );
    await Promise.resolve();

    cancelSessionPreparation();
    expect(signal?.aborted).toBe(true);
    expect(sessionSelectStore.get().preparation.kind).toBe('idle');
    expect(overlayStore.get().active).toBe('sessions');

    const active = reactivateExistingSession({ projectDir: tmp, sessionId: session.id });
    const execution = {
      ...preparedResumeExecution(tmp, session.id, savedState),
      session: {
        kind: 'existing' as const,
        ref: { projectDir: tmp, sessionId: session.id },
        active,
      },
    };
    pending.resolve({ kind: 'prepared', execution });
    await selection;

    expect(readActive(tmp)).toBeNull();
    expect(routerStore.get().screen).toBe('home');
  });

  it('routes only the latest selection and preserves its newer active receipt', async () => {
    const firstSession = makeSession({
      id: 'sess-first',
      feature: 'first resume',
      status: 'interrupted',
      summary: null,
    });
    const secondSession = makeSession({
      id: 'sess-second',
      feature: 'second resume',
      status: 'interrupted',
      summary: null,
    });
    const states = new Map([
      [firstSession.id, { ...createInitialState('first resume'), phase: 'implementing' as const }],
      [
        secondSession.id,
        { ...createInitialState('second resume'), phase: 'implementing' as const },
      ],
    ]);
    const first = Promise.withResolvers<PreparationOutcome>();
    const second = Promise.withResolvers<PreparationOutcome>();
    const signals: AbortSignal[] = [];
    const prepareResume: SessionSelectDeps['prepareResume'] = ({ ref }, signal) => {
      signals.push(signal);
      return ref.sessionId === firstSession.id ? first.promise : second.promise;
    };
    const deps = sessionSelectDeps({
      ...makeResumeAuthorityDeps(({ sessionId }) => states.get(sessionId) ?? null),
      prepareResume,
    });

    const firstSelection = handleSessionSelect(firstSession, tmp, deps);
    await Promise.resolve();
    const secondSelection = handleSessionSelect(secondSession, tmp, deps);
    await Promise.resolve();
    expect(signals[0]?.aborted).toBe(true);

    const secondActive = reactivateExistingSession({
      projectDir: tmp,
      sessionId: secondSession.id,
    });
    second.resolve({
      kind: 'prepared',
      execution: {
        ...preparedResumeExecution(tmp, secondSession.id, states.get(secondSession.id)!),
        session: {
          kind: 'existing',
          ref: { projectDir: tmp, sessionId: secondSession.id },
          active: secondActive,
        },
      },
    });
    await secondSelection;

    first.resolve({
      kind: 'prepared',
      execution: preparedResumeExecution(tmp, firstSession.id, states.get(firstSession.id)!),
    });
    await firstSelection;

    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow' && route.execution.kind === 'local') {
      expect(route.execution.prepared.session.ref.sessionId).toBe(secondSession.id);
    }
    expect(readActive(tmp)).toBe(secondSession.id);
  });

  it('reifies an unexpected preparation rejection as a generic failed state', async () => {
    const session = makeSession({
      id: 'sess-rejected',
      feature: 'rejected resume',
      status: 'interrupted',
      summary: null,
    });
    const savedState = { ...createInitialState('rejected resume'), phase: 'implementing' as const };

    await expect(
      handleSessionSelect(
        session,
        tmp,
        sessionSelectDeps({
          ...makeResumeAuthorityDeps(() => savedState),
          prepareResume: async () => {
            throw new Error('resume boundary rejected');
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(sessionSelectStore.get().preparation).toMatchObject({
      kind: 'failed',
      error: expect.objectContaining({ message: 'resume boundary rejected' }),
    });
  });

  it('refuses to resume an interrupted session whose saved state never reached a resumable phase', async () => {
    overlayStore.open('sessions');
    const session = makeSession({
      id: 'sess-poisoned',
      feature: 'add auth',
      status: 'interrupted',
      summary: null,
    });
    const savedState = { ...createInitialState('saved add auth'), phase: 'idle' as const };
    saveState({ projectDir: tmp, sessionId: session.id }, savedState);

    await handleSessionSelect(session, tmp, sessionSelectDeps());

    expect(overlayStore.get().active).toBe('sessions');
    expect(routerStore.get().screen).toBe('home');
    const { error } = sessionSelectStore.get();
    expect(error ?? '').toContain('interrupted before it made progress');
    expect(error ?? '').toContain('add auth');
  });

  it('keeps the picker open and surfaces feedback when an interrupted session has no valid state', async () => {
    overlayStore.open('sessions');
    const session = makeSession({
      id: 'sess-missing-state',
      feature: 'add auth',
      status: 'interrupted',
      summary: null,
    });

    await handleSessionSelect(session, tmp, sessionSelectDeps());

    expect(overlayStore.get().active).toBe('sessions');
    expect(routerStore.get().screen).toBe('home');
    expect(sessionSelectStore.get().error ?? '').toContain('saved workflow state');
  });

  it('opens an interrupted session summary when no resumable state is available', async () => {
    overlayStore.open('sessions');
    const summary = makeSummary({ feature: 'partial refactor' });
    const session = makeSession({
      id: 'sess-interrupted-summary',
      feature: 'partial refactor',
      status: 'interrupted',
      summary,
    });

    await handleSessionSelect(session, tmp, sessionSelectDeps());

    expect(overlayStore.get().active).toBe('none');
    const route = routerStore.get();
    expect(route.screen).toBe('summary');
    if (route.screen === 'summary') {
      expect(route.summary).toEqual(summary);
      expect(route.sessionId).toBe('sess-interrupted-summary');
      expect(route.status).toBe('interrupted');
    }
    expect(sessionSelectStore.get().error).toBeNull();
  });

  it('navigates from home to the summary screen when the session completed with a summary', async () => {
    overlayStore.open('sessions');
    const summary = makeSummary({ feature: 'refactor payments' });
    const session = makeSession({ id: 'sess-complete', status: 'complete', summary });

    await handleSessionSelect(session, tmp, sessionSelectDeps());

    expect(overlayStore.get().active).toBe('none');
    const route = routerStore.get();
    expect(route.screen).toBe('summary');
    if (route.screen === 'summary') {
      expect(route.summary).toEqual(summary);
      expect(route.sessionId).toBe('sess-complete');
      expect(route.status).toBe('complete');
    }
    expect(sessionSelectStore.get().error).toBeNull();
  });

  it('replaces an open summary when a failed session has a summary to display', async () => {
    routerStore.init({
      screen: 'summary',
      summary: makeSummary({ feature: 'old summary' }),
      sessionId: 'old-session',
      status: 'complete',
    });
    overlayStore.open('sessions');
    const summary = makeSummary({ feature: 'failed feature' });
    const session = makeSession({
      id: 'failed-summary',
      feature: 'failed feature',
      status: 'failed',
      summary,
    });

    await handleSessionSelect(session, tmp, sessionSelectDeps());

    expect(overlayStore.get().active).toBe('none');
    const route = routerStore.get();
    expect(route.screen).toBe('summary');
    if (route.screen === 'summary') {
      expect(route.summary).toEqual(summary);
      expect(route.sessionId).toBe('failed-summary');
      expect(route.status).toBe('failed');
    }
    expect(sessionSelectStore.get().error).toBeNull();
  });

  it('keeps the overlay open and surfaces feedback for a failed session without a summary', async () => {
    overlayStore.open('sessions');
    const session = makeSession({ feature: 'add auth', status: 'failed', summary: null });

    await handleSessionSelect(session, tmp, sessionSelectDeps());

    expect(overlayStore.get().active).toBe('sessions');
    expect(routerStore.get().screen).toBe('home');
    expect(sessionSelectStore.get().error ?? '').toContain('add auth');
  });

  it('strips OSC-52/CSI control bytes from the feature name interpolated into a selection error', async () => {
    overlayStore.open('sessions');
    const payload = 'ZWNobyBwd25lZA==';
    const malicious = `before\u001b]52;c;${payload}\u0007\u001b[2Jafter`;
    const session = makeSession({ feature: malicious, status: 'failed', summary: null });

    await handleSessionSelect(session, tmp, sessionSelectDeps());

    const error = sessionSelectStore.get().error ?? '';
    expect(error).toContain('beforeafter');
    expect(error).not.toContain(payload);
    expect(error).not.toContain(']52');
    expect(error).not.toContain('[2J');
  });

  it('surfaces an error and stays on home when loadState throws for an interrupted session with an unsafe id', async () => {
    overlayStore.open('sessions');
    const session = makeSession({
      id: 'bad/id',
      feature: 'add auth',
      status: 'interrupted',
      summary: null,
    });

    await handleSessionSelect(session, tmp, sessionSelectDeps());

    const { error } = sessionSelectStore.get();
    expect(error ?? '').toContain('add auth');
    expect(error ?? '').toContain('Cannot resume');
    expect(overlayStore.get().active).toBe('sessions');
    expect(routerStore.get().screen).toBe('home');
  });
});
