import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createInitialState } from '../../core/state/machine.js';
import {
  clearActiveReceipt,
  readActive,
  readActiveRecord,
  reactivateExistingSession,
} from '../../core/sessions/active-pointer.js';
import { saveState } from '../../core/state/persistence.js';
import { loadOwnerWorkflowState } from '../../core/state/resume-hydration.js';
import type { UserMessageInput } from '../../core/types/user-input.js';
import type { RunRecord } from '../../core/sessions/run-record.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type {
  PreparationOutcome,
  PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import { parsePreparedConfig } from '../../engine/runners/prepared-execution.js';
import { skillsStore } from '../project/skills.js';
import { overlayStore } from '../ui/overlay.js';
import { hydrateFromState } from '../workflow/actions/hydrate.js';
import { loadEvents } from '../workflow/actions/load.js';
import { resetWorkflow } from '../workflow/actions/reset.js';
import { eventsStore } from '../workflow/events.js';
import { lifecycleStore } from '../workflow/lifecycle.js';
import { operationsStore } from '../workflow/operations/state.js';
import { tasksStore } from '../workflow/tasks.js';
import { tokensStore } from '../workflow/tokens.js';
import { routerStore } from './router.js';
import { preparationStore } from './preparation.js';
import {
  cancelSessionPreparation,
  continueRunInPlace,
  handleSessionSelect,
  retrySessionPreparation,
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
      stop: { kind: 'stopped', on: { kind: 'interrupted' } },
      resumeAt: { kind: 'planner', call: 'tasks' },
    },
  });
}

/** A replay the test holds open, finished per session once the test says so. */
function heldHistory() {
  const reads = new Map<string, PromiseWithResolvers<() => void>>();
  const readRunHistory = vi.fn((record: RunRecord) => {
    const read = Promise.withResolvers<() => void>();
    reads.set(record.ref.sessionId, read);
    return read.promise;
  });
  const finish = (sessionId: string, publish: () => void) => reads.get(sessionId)?.resolve(publish);
  return { readRunHistory, finish };
}

/** The publish step of a real replay: transcript, briefs, lifecycle and spend, all written. */
function publishRun(feature: string) {
  return vi.fn(() => {
    loadEvents([{ type: 'workflow_started', ts: 1_000, phase: 'planning', feature }]);
    hydrateFromState({
      ...createInitialState(feature),
      phase: 'implementing',
      tasks: [makeTask({ id: 'T001', title: feature })],
      tokenUsage: makeUsage({ plannerInput: feature.length }),
    });
  });
}

function onScreen() {
  return {
    route: routerStore.get(),
    events: eventsStore.get(),
    tasks: tasksStore.get(),
    lifecycle: lifecycleStore.get(),
    tokens: tokensStore.get(),
    operations: operationsStore.get(),
  };
}

let unsubscribers: (() => void)[] = [];

function countWrites(): () => number {
  let writes = 0;
  const count = () => {
    writes += 1;
  };
  unsubscribers = [
    routerStore,
    eventsStore,
    tasksStore,
    lifecycleStore,
    tokensStore,
    operationsStore,
  ].map((store) => store.subscribe(count));
  return () => writes;
}

beforeEach(() => {
  tmp = createTempDir('session-select-test');
  resetWorkflow();
  overlayStore.reset();
  routerStore.reset();
  sessionSelectStore.reset();
  preparationStore.reset();
  skillsStore.reset();
});

afterEach(() => {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  resetWorkflow();
  if (tmp) cleanupTempDir(tmp);
  overlayStore.reset();
  routerStore.reset();
  sessionSelectStore.reset();
  preparationStore.reset();
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

  it.each([
    { saved: ['z-skill'], selected: ['z-skill'] },
    { saved: undefined, selected: [] },
  ])(
    'selects the saved skills $saved of the opened run, whatever was selected before',
    async ({ saved, selected }) => {
      skillsStore.setSelected(new Set(['x-skill']));
      const session = makeSession({ id: 'sess-skills', feature: 'saved skills', status: 'open' });
      saveState(
        { projectDir: tmp, sessionId: session.id },
        {
          ...createInitialState('saved skills'),
          phase: 'implementing',
          ...(saved !== undefined && { selectedSkills: saved }),
        },
      );

      await handleSessionSelect(session, tmp, sessionSelectDeps());

      expect([...skillsStore.get().selected]).toEqual(selected);
    },
  );

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

describe('handleSessionSelect with a history read in flight', () => {
  it('publishes the newer run once and drops the older replay that lands after it', async () => {
    const history = heldHistory();
    const deps = sessionSelectDeps({ readRunHistory: history.readRunHistory });
    const publishA = publishRun('run A');
    const publishB = publishRun('run B');

    const selectA = handleSessionSelect(makeSession({ id: 'sess-a', feature: 'run A' }), tmp, deps);
    const selectB = handleSessionSelect(makeSession({ id: 'sess-b', feature: 'run B' }), tmp, deps);
    history.finish('sess-b', publishB);
    await selectB;
    const shown = onScreen();
    const writes = countWrites();
    history.finish('sess-a', publishA);
    await selectA;

    expect(publishB).toHaveBeenCalledOnce();
    expect(publishA).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
    for (const [name, value] of Object.entries(onScreen())) {
      expect(value, name).toBe(shown[name as keyof typeof shown]);
    }
    const route = routerStore.get();
    expect(route.screen === 'workflow' && route.run.ref.sessionId).toBe('sess-b');
    expect(JSON.stringify(eventsStore.get().events)).toContain('run B');
    expect(tasksStore.get().taskMap.get('T001')?.title).toBe('run B');
    expect(tokensStore.get().tokenUsage?.plannerInput).toBe('run B'.length);
    expect(lifecycleStore.get().phase).toBe('implementing');
  });

  it.each([
    {
      superseded: 'a new start checking tools on Home',
      supersede: () => {
        preparationStore.submit({
          origin: 'start',
          stage: 'Checking tools',
          prepare: () => new Promise(() => {}),
          onPrepared: () => {
            throw new Error('The pending start must not hand off');
          },
        });
      },
    },
    {
      superseded: 'a local run started on screen',
      supersede: () => {
        const state = { ...createInitialState('local run'), phase: 'implementing' as const };
        const prepared = preparedResumeExecution(tmp, 'sess-local', state);
        routerStore.navigate({
          to: 'workflow',
          run: makeRunRecord({ ref: prepared.session.ref }),
          execution: { kind: 'local', prepared },
        });
      },
    },
    {
      superseded: 'a continuation of the run on screen',
      before: () =>
        routerStore.navigate({
          to: 'workflow',
          run: openRecord('sess-x'),
          execution: { kind: 'at-rest' },
        }),
      supersede: () => {
        void continueRunInPlace({
          record: openRecord('sess-x'),
          state: { ...createInitialState('continue x'), phase: 'implementing' as const },
          deps: sessionSelectDeps({ prepareResume: () => new Promise(() => {}) }),
        });
      },
    },
    { superseded: 'cancelling the selection', supersede: () => cancelSessionPreparation() },
    {
      superseded: 'navigating home',
      before: () =>
        routerStore.navigate({
          to: 'workflow',
          run: openRecord('sess-x'),
          execution: { kind: 'at-rest' },
        }),
      supersede: () => routerStore.navigate({ to: 'home' }),
    },
  ])('writes nothing when the replay lands after $superseded', async ({ before, supersede }) => {
    before?.();
    const history = heldHistory();
    const publishA = publishRun('run A');

    const selectA = handleSessionSelect(
      makeSession({ id: 'sess-a', feature: 'run A' }),
      tmp,
      sessionSelectDeps({ readRunHistory: history.readRunHistory }),
    );
    supersede();
    const shown = onScreen();
    const writes = countWrites();
    history.finish('sess-a', publishA);
    await selectA;

    expect(publishA).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
    for (const [name, value] of Object.entries(onScreen())) {
      expect(value, name).toBe(shown[name as keyof typeof shown]);
    }
  });
});

describe('continueRunInPlace', () => {
  it('does not cancel a newer start or restore an old overlay when an older continuation cancels', async () => {
    const savedState = { ...createInitialState('run A'), phase: 'implementing' as const };
    const record = openRecord('sess-a');
    overlayStore.open('sessions');
    const pendingContinue = Promise.withResolvers<PreparationOutcome>();
    const continuing = continueRunInPlace({
      record,
      state: savedState,
      deps: sessionSelectDeps({ prepareResume: () => pendingContinue.promise }),
    });
    const pendingStart = Promise.withResolvers<PreparationOutcome>();
    let started = false;
    const start = preparationStore.submit({
      origin: 'start',
      stage: 'Checking tools',
      prepare: () => pendingStart.promise,
      onPrepared: () => {
        started = true;
      },
    });

    cancelSessionPreparation();
    expect(overlayStore.get().active).toBe('none');
    expect(preparationStore.get()).toMatchObject({ kind: 'checking', attempt: start.attempt });
    pendingContinue.resolve({ kind: 'aborted' });
    await continuing;
    pendingStart.resolve({
      kind: 'prepared',
      execution: preparedResumeExecution(tmp, 'sess-start', savedState),
    });
    await start.promise;
    expect(started).toBe(true);
  });

  it.each(['prepared', 'blocked', 'failed', 'rejected'] as const)(
    'keeps the newly selected run and its replay after the old continuation is %s',
    async (outcome) => {
      const savedState = { ...createInitialState('run A'), phase: 'implementing' as const };
      const record = openRecord('sess-a');
      routerStore.navigate({ to: 'workflow', run: record, execution: { kind: 'at-rest' } });
      overlayStore.open('sessions');
      const pending = Promise.withResolvers<PreparationOutcome>();
      let signal: AbortSignal | undefined;
      const deps = sessionSelectDeps({
        prepareResume: (_input, attemptSignal) => {
          signal = attemptSignal;
          return pending.promise;
        },
        readRunHistory: async () => publishRun('run B'),
      });
      const continuing = continueRunInPlace({ record, state: savedState, deps });
      await Promise.resolve();
      await handleSessionSelect(makeSession({ id: 'sess-b', feature: 'run B' }), tmp, deps);
      expect(signal?.aborted).toBe(true);
      expect(overlayStore.get().active).toBe('none');
      const shown = onScreen();
      const writes = countWrites();
      const stale = reactivateExistingSession(record.ref);
      clearActiveReceipt(record.ref, stale);
      const current = reactivateExistingSession({ projectDir: tmp, sessionId: 'sess-b' });
      const execution = {
        ...preparedResumeExecution(tmp, record.ref.sessionId, savedState),
        session: { kind: 'existing' as const, ref: record.ref, active: stale },
      };
      switch (outcome) {
        case 'prepared':
          pending.resolve({ kind: 'prepared', execution });
          break;
        case 'blocked':
          pending.resolve({ kind: 'blocked', report: execution.report });
          break;
        case 'failed':
          pending.resolve({ kind: 'failed', error: new Error('late failure') });
          break;
        case 'rejected':
          pending.reject(new Error('late rejection'));
          break;
      }
      await continuing;
      await retrySessionPreparation();

      expect(preparationStore.get().kind).toBe('idle');
      expect(readActiveRecord(tmp)).toMatchObject({ kind: 'v1', receipt: current });
      expect(writes()).toBe(0);
      for (const [name, value] of Object.entries(onScreen())) {
        expect(value, name).toBe(shown[name as keyof typeof shown]);
      }
    },
  );

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

    const steer: UserMessageInput = {
      text: 'use @/outside/parser.txt\n\n--- @/outside/parser.txt ---\nparser body',
      displayText: 'use @/outside/parser.txt',
      images: [],
      attachedInputs: [{ kind: 'text', path: '/outside/parser.txt' }],
    };
    const attempt = continueRunInPlace({
      record,
      state: savedState,
      steer,
      deps,
    });
    expect(sessionSelectStore.get().preparation.kind).toBe('preparing');
    pending.resolve({ kind: 'prepared', execution: prepared });
    await attempt;

    const route = routerStore.get();
    expect(route.screen).toBe('workflow');
    if (route.screen === 'workflow' && route.execution.kind === 'local') {
      expect(route.execution.prepared).toBe(prepared);
      expect(route.execution.steer).toBe(steer);
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

  it('keeps the complete restarted steer through a blocked preparation and retry', async () => {
    const record = openRecord('steer-retry');
    const state = { ...createInitialState('continue me'), phase: 'implementing' as const };
    const prepared = preparedResumeExecution(tmp, record.ref.sessionId, state);
    const steer: UserMessageInput = {
      text: 'use @/outside/context.txt\n\n--- @/outside/context.txt ---\nbody',
      displayText: 'use @/outside/context.txt',
      images: [
        { id: 'a', kind: 'image', path: '/outside/a.png', mimeType: 'image/png', sizeBytes: 1 },
      ],
      attachedInputs: [
        { kind: 'text', path: '/outside/context.txt' },
        { kind: 'image', path: '/outside/a.png' },
      ],
    };
    routerStore.navigate({ to: 'workflow', run: record, execution: { kind: 'at-rest' } });
    const prepareResume = vi
      .fn<SessionSelectDeps['prepareResume']>()
      .mockResolvedValueOnce({ kind: 'blocked', report: prepared.report })
      .mockResolvedValueOnce({ kind: 'prepared', execution: prepared });

    await continueRunInPlace({ record, state, steer, deps: sessionSelectDeps({ prepareResume }) });
    expect(sessionSelectStore.get().preparation.kind).toBe('blocked');
    await retrySessionPreparation();
    expect(routerStore.get()).toMatchObject({
      screen: 'workflow',
      execution: { kind: 'local', steer },
    });
    expect(prepareResume).toHaveBeenCalledTimes(2);
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
