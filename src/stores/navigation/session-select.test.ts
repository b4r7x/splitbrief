import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { createInitialState } from '../../core/state/machine.js';
import { readActive, reactivateExistingSession } from '../../core/sessions/active-pointer.js';
import { saveState } from '../../core/state/persistence.js';
import { loadOwnerWorkflowState } from '../../core/state/resume-hydration.js';
import type { RunRecord } from '../../core/sessions/run-record.js';
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
  continueRunInPlace,
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
    loadResumeState: loadOwnerWorkflowState,
    prepareResume: async () => {
      throw new Error('Resume preparation was not expected');
    },
    hydrateRun: async () => {},
    ...overrides,
  };
}

function openRecord(sessionId: string): RunRecord {
  return makeRunRecord({
    ref: { projectDir: tmp, sessionId },
    status: {
      kind: 'open',
      stop: { kind: 'interrupted' },
      resumeAt: { kind: 'planner', call: 'tasks' },
    },
  });
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

describe('handleSessionSelect', () => {
  it('replays the run and opens it at rest, whatever the run did', async () => {
    overlayStore.open('sessions');
    const session = makeSession({ id: 'sess-open', feature: 'add auth', status: 'open' });
    const savedState = { ...createInitialState('saved add auth'), phase: 'implementing' as const };
    saveState({ projectDir: tmp, sessionId: session.id }, savedState);
    const hydrateRun = vi.fn(async (_record: RunRecord) => {});

    await handleSessionSelect(session, tmp, sessionSelectDeps({ hydrateRun }));

    expect(hydrateRun).toHaveBeenCalledOnce();
    const hydrated = hydrateRun.mock.calls.at(0);
    expect(hydrated).toBeDefined();
    expect(overlayStore.get().active).toBe('none');
    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.execution.kind).toBe('at-rest');
      expect(route.run.ref.sessionId).toBe(session.id);
    }
    expect(sessionSelectStore.get().error).toBeNull();
  });

  it('opens a finished run the same way, without preparing anything', async () => {
    const session = makeSession({ id: 'sess-complete', feature: 'shipped', status: 'complete' });
    const prepareResume = vi.fn<SessionSelectDeps['prepareResume']>();

    await handleSessionSelect(session, tmp, sessionSelectDeps({ prepareResume }));

    expect(prepareResume).not.toHaveBeenCalled();
    expect(routerStore.get().screen).toBe('workflow');
  });

  it('opens a run whose state cannot be read, rather than refusing to show it', async () => {
    overlayStore.open('sessions');
    const session = makeSession({ id: 'sess-no-state', feature: 'add auth', status: 'open' });

    await handleSessionSelect(session, tmp, sessionSelectDeps());

    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow') {
      expect(route.run.hydration.kind).not.toBe('loaded');
      expect(route.execution.kind).toBe('at-rest');
    }
    expect(sessionSelectStore.get().error).toBeNull();
  });

  it('refuses to replace a local workflow this process is driving', async () => {
    const currentState = {
      ...createInitialState('current local workflow'),
      phase: 'implementing' as const,
    };
    const currentPrepared = preparedResumeExecution(tmp, 'current-local', currentState);
    routerStore.navigate({
      to: 'workflow',
      run: makeRunRecord({ ref: currentPrepared.session.ref }),
      execution: { kind: 'local', prepared: currentPrepared },
    });
    const exactRoute = routerStore.get();
    overlayStore.open('sessions');
    const selected = makeSession({ id: 'resume-other', feature: 'another run', status: 'open' });
    const hydrateRun = vi.fn(async () => {});

    await handleSessionSelect(selected, tmp, sessionSelectDeps({ hydrateRun }));

    expect(hydrateRun).not.toHaveBeenCalled();
    expect(routerStore.get()).toBe(exactRoute);
    expect(overlayStore.get().active).toBe('sessions');
    expect(sessionSelectStore.get().error).toContain('another run');
  });
});

describe('continueRunInPlace', () => {
  it('flips the execution in place once the tools are prepared, carrying the steer', async () => {
    const savedState = { ...createInitialState('continue me'), phase: 'implementing' as const };
    const record = openRecord('sess-continue');
    routerStore.navigate({ to: 'workflow', run: record, execution: { kind: 'at-rest' } });
    const prepared = preparedResumeExecution(tmp, record.ref.sessionId, savedState);
    const pending = Promise.withResolvers<PreparationOutcome>();
    const deps = sessionSelectDeps({
      prepareResume: async ({ ref, state }) => {
        expect(ref).toEqual(record.ref);
        expect(state).toBe(savedState);
        return pending.promise;
      },
    });

    const attempt = continueRunInPlace({
      record,
      state: savedState,
      steer: 'use the cached parser',
      deps,
    });
    expect(sessionSelectStore.get().preparation.kind).toBe('preparing');
    pending.resolve({ kind: 'prepared', execution: prepared });
    await attempt;

    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow' && route.execution.kind === 'local') {
      expect(route.execution.prepared).toBe(prepared);
      expect(route.execution.steer).toBe('use the cached parser');
    }
    expect(sessionSelectStore.get().preparation.kind).toBe('idle');
  });

  it('single-flights a duplicate continuation of the same run', async () => {
    const savedState = { ...createInitialState('resume once'), phase: 'implementing' as const };
    const record = openRecord('sess-duplicate');
    const pending = Promise.withResolvers<PreparationOutcome>();
    const signals: AbortSignal[] = [];
    const prepareResume = vi.fn((_input, signal: AbortSignal) => {
      signals.push(signal);
      return pending.promise;
    });
    const deps = sessionSelectDeps({ prepareResume });

    const first = continueRunInPlace({ record, state: savedState, deps });
    const duplicate = continueRunInPlace({ record, state: savedState, deps });
    await Promise.resolve();

    expect(prepareResume).toHaveBeenCalledOnce();
    expect(signals).toHaveLength(1);

    pending.resolve({
      kind: 'blocked',
      report: preparedResumeExecution(tmp, record.ref.sessionId, savedState).report,
    });
    await Promise.all([first, duplicate]);
    expect(sessionSelectStore.get().preparation.kind).toBe('blocked');
  });

  it('cancels the caller-owned signal and clears a late existing-session receipt', async () => {
    overlayStore.open('sessions');
    const savedState = { ...createInitialState('cancel resume'), phase: 'implementing' as const };
    const record = openRecord('sess-cancelled');
    const pending = Promise.withResolvers<PreparationOutcome>();
    let signal: AbortSignal | undefined;
    const attempt = continueRunInPlace({
      record,
      state: savedState,
      deps: sessionSelectDeps({
        prepareResume: (_input, attemptSignal) => {
          signal = attemptSignal;
          return pending.promise;
        },
      }),
    });
    await Promise.resolve();

    cancelSessionPreparation();
    expect(signal?.aborted).toBe(true);
    expect(sessionSelectStore.get().preparation.kind).toBe('idle');

    const active = reactivateExistingSession({ projectDir: tmp, sessionId: record.ref.sessionId });
    pending.resolve({
      kind: 'prepared',
      execution: {
        ...preparedResumeExecution(tmp, record.ref.sessionId, savedState),
        session: {
          kind: 'existing',
          ref: record.ref,
          active,
        },
      },
    });
    await attempt;

    expect(readActive(tmp)).toBeNull();
    expect(routerStore.get().screen).toBe('home');
  });

  it('reifies an unexpected preparation rejection as a generic failed state', async () => {
    const savedState = { ...createInitialState('rejected resume'), phase: 'implementing' as const };

    await continueRunInPlace({
      record: openRecord('sess-rejected'),
      state: savedState,
      deps: sessionSelectDeps({
        prepareResume: async () => {
          throw new Error('resume boundary rejected');
        },
      }),
    });

    expect(sessionSelectStore.get().preparation).toMatchObject({
      kind: 'failed',
      error: expect.objectContaining({ message: 'resume boundary rejected' }),
    });
  });
});
