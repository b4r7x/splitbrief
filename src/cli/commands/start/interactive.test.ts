import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realpathSync } from 'node:fs';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { writeConfigMarker, prepareExecutionMock } from '#testing/helpers/start-command.js';
import { saveDetectionCache } from '../../../engine/detection/cache.js';
import * as capabilitiesModule from '../../../engine/providers/capabilities.js';
import * as initStoresModule from '../../bootstrap/init.js';
import * as setupModule from '../../setup.js';
import { COLD_START_STDERR_LINE } from '../../../core/discovery/copy.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import {
  reactivateExistingSession,
  readActive,
  readActiveRecord,
  type ActiveSessionReceipt,
} from '../../../core/sessions/active-pointer.js';
import type { PreparationOutcome } from '../../../engine/runners/prepared-execution.js';
import { preparationStore } from '../../../stores/navigation/preparation.js';
import {
  approvalPromptStore,
  closeApprovalPrompt,
} from '../../../stores/approval-prompt/prompt.js';
import type {
  TieredApprovalRequest,
  TieredApprovalResponse,
} from '../../../core/approval/types.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { runInteractiveStart } from './interactive.js';
import * as readinessModule from './readiness.js';
import type { InteractiveDispatchArgs, StartDeps } from './types.js';

setupFetchMock();

let tmp = '';

const renderAppFake: StartDeps['renderApp'] = async () => {};

beforeEach(() => {
  vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('{}', { status: 200 }));
  tmp = realpathSync(createTempDir('interactive-start-test'));
  writeConfigMarker(tmp);
  resetAllStores();
  preparationStore.reset();
  process.stdin.isTTY = true;
});

afterEach(() => {
  preparationStore.reset();
  vi.restoreAllMocks();
  if (tmp) cleanupTempDir(tmp);
  delete (process.stdin as { isTTY?: boolean }).isTTY;
});

function makeDispatch(overrides: Partial<InteractiveDispatchArgs> = {}): InteractiveDispatchArgs {
  const deps: StartDeps = {
    runHeadless: vi.fn(),
    initStores: async () => {},
    renderApp: renderAppFake,
    prepareExecution: prepareExecutionMock,
    ...(overrides.deps ?? {}),
  };
  return {
    deps,
    projectDir: tmp,
    feature: undefined,
    enrichedFeature: undefined,
    plannerContext: undefined,
    opts: { project: tmp },
    ...overrides,
  };
}

describe('runInteractiveStart', () => {
  it('writes cold-start stderr progress before setupWorkflow on a first run (T-037)', async () => {
    const setupGate =
      Promise.withResolvers<Awaited<ReturnType<typeof setupModule.setupWorkflow>>>();
    const setupSpy = vi
      .spyOn(setupModule, 'setupWorkflow')
      .mockImplementation(() => setupGate.promise);
    const initSpy = vi
      .spyOn(initStoresModule, 'initStoresForTuiMount')
      .mockResolvedValue({ awaitDiscovery: Promise.resolve() });
    vi.spyOn(readinessModule, 'assertNoLiveSessionForCli').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const run = runInteractiveStart(makeDispatch());

    await Promise.resolve();
    expect(stderrSpy).toHaveBeenCalledWith(COLD_START_STDERR_LINE);
    expect(setupSpy).toHaveBeenCalledOnce();
    expect(initSpy).not.toHaveBeenCalled();

    setupGate.resolve({
      projectDir: tmp,
      useFullscreen: false,
      useMouse: false,
      useHover: false,
    });
    await run;
  });

  it('does not claim a first run once detection results were remembered (T-037)', async () => {
    const observedAt = Date.now();
    await saveDetectionCache({
      projectDir: tmp,
      snapshot: {
        contextKey: 'readiness-context',
        fetchedAt: observedAt,
        validatedAt: observedAt,
        generation: 1,
        requestId: 1,
        providers: [],
        cliTools: [],
      },
    });
    vi.spyOn(setupModule, 'setupWorkflow').mockResolvedValue({
      projectDir: tmp,
      useFullscreen: false,
      useMouse: false,
      useHover: false,
    });
    vi.spyOn(initStoresModule, 'initStoresForTuiMount').mockResolvedValue({
      awaitDiscovery: Promise.resolve(),
    });
    vi.spyOn(readinessModule, 'assertNoLiveSessionForCli').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runInteractiveStart(makeDispatch());

    expect(stderrSpy).not.toHaveBeenCalledWith(COLD_START_STDERR_LINE);
  });

  it('mounts Ink before store discovery finishes (T-037)', async () => {
    const discoveryGate = Promise.withResolvers<void>();
    vi.spyOn(capabilitiesModule, 'detectCapabilities').mockImplementation(async () => {
      await discoveryGate.promise;
      return { contextLength: 32_768, origin: 'fallback' as const };
    });
    vi.spyOn(setupModule, 'setupWorkflow').mockResolvedValue({
      projectDir: tmp,
      useFullscreen: false,
      useMouse: false,
      useHover: false,
    });
    vi.spyOn(readinessModule, 'assertNoLiveSessionForCli').mockImplementation(() => {});

    let renderStarted = false;
    const renderApp: StartDeps['renderApp'] = async () => {
      renderStarted = true;
    };

    const run = runInteractiveStart(
      makeDispatch({
        deps: {
          runHeadless: vi.fn(),
          initStores: async () => {},
          renderApp,
          prepareExecution: prepareExecutionMock,
        },
      }),
    );

    // A failing gate would otherwise abandon `run` mid-flight, and its teardown
    // git call reaches the removed temp dir as an unhandled rejection charged to
    // whichever test runs next. `await run` below still observes a real failure.
    run.catch(() => {});

    await vi.waitFor(() => expect(renderStarted).toBe(true), { timeout: 10_000 });

    discoveryGate.resolve();
    await run;
  }, 20_000);

  it('unmounts the TUI before a readiness blocker reaches the terminal (T-037)', async () => {
    vi.spyOn(setupModule, 'setupWorkflow').mockResolvedValue({
      projectDir: tmp,
      useFullscreen: false,
      useMouse: false,
      useHover: false,
    });
    const events: string[] = [];
    const renderApp: StartDeps['renderApp'] = async (_app, options) => {
      events.push('mounted');
      await new Promise<void>((resolve) => {
        options.unmountSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      events.push('restored');
    };
    // Only the blocker report counts as the 'blockers' event: an unrelated line
    // on stdout would otherwise be indistinguishable from it and invert the order
    // this test exists to pin.
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      if (typeof line === 'string' && line.startsWith('Run readiness: blocked')) {
        events.push('blockers');
      }
    });

    const run = runInteractiveStart(
      makeDispatch({
        feature: 'ship it',
        deps: {
          runHeadless: vi.fn(),
          initStores: async () => {},
          renderApp,
          prepareExecution: async () => ({ kind: 'blocked', report: blockedReport(tmp) }),
        },
      }),
    );

    await expect(run).rejects.toThrow(/Run readiness blocked/u);
    expect(events).toEqual(['mounted', 'restored', 'blockers']);
  });

  it('asks for runner trust on the panel inside the TUI, not on the terminal behind it', async () => {
    vi.spyOn(setupModule, 'setupWorkflow').mockResolvedValue({
      projectDir: tmp,
      useFullscreen: false,
      useMouse: false,
      useHover: false,
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const request: TieredApprovalRequest = {
      tier: 'confirm',
      actionClass: 'network',
      actionDescription: 'Run the configured shell planner',
      phase: 'planning',
    };
    let answered: TieredApprovalResponse | undefined;

    const run = runInteractiveStart(
      makeDispatch({
        feature: 'ship it',
        deps: {
          runHeadless: vi.fn(),
          initStores: async () => {},
          renderApp: renderAppFake,
          prepareExecution: async (input) => {
            answered = await input.policy.onTieredApproval?.(request);
            return { kind: 'blocked', report: blockedReport(tmp) };
          },
        },
      }),
    );

    await vi.waitFor(() => {
      expect(approvalPromptStore.get()).toMatchObject({ status: 'pending', request });
    });
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining(request.actionDescription));
    closeApprovalPrompt({ decision: 'deny', reason: 'not now' });

    await expect(run).rejects.toThrow(/Run readiness blocked/u);
    expect(answered).toEqual({ decision: 'deny', reason: 'not now' });
  });
});

const SESSION_ID = 'sess-launch';

/** A CLI start whose preparation the test settles by hand, mounted into an inert terminal. */
async function heldCliLaunch() {
  vi.spyOn(setupModule, 'setupWorkflow').mockResolvedValue({
    projectDir: tmp,
    useFullscreen: false,
    useMouse: false,
    useHover: false,
  });
  vi.spyOn(initStoresModule, 'initStoresForTuiMount').mockResolvedValue({
    awaitDiscovery: Promise.resolve(),
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => {});

  const outcome = Promise.withResolvers<PreparationOutcome>();
  let signal: AbortSignal | undefined;
  let unmountSignal: AbortSignal | undefined;
  let restores = 0;
  // The TUI stays up until the launch tears it down or the user quits it.
  const quit = Promise.withResolvers<void>();
  const renderApp: StartDeps['renderApp'] = async (_app, options) => {
    unmountSignal = options.unmountSignal;
    const torndown = new Promise<void>((resolve) => {
      options.unmountSignal?.addEventListener('abort', () => resolve(), { once: true });
    }).then(() => {
      restores += 1;
    });
    await Promise.race([torndown, quit.promise]);
  };
  const run = runInteractiveStart(
    makeDispatch({
      feature: 'ship A',
      deps: {
        runHeadless: vi.fn(),
        initStores: async () => {},
        renderApp,
        prepareExecution: async (input) => {
          signal = input.signal;
          return outcome.promise;
        },
      },
    }),
  );
  run.catch(() => {});
  await vi.waitFor(() => expect(signal).toBeDefined());
  const attempt = preparationStore.get();
  if (attempt.kind !== 'checking') throw new Error('The CLI start did not submit an attempt.');

  return {
    run,
    quit: () => quit.resolve(),
    outcome,
    attempt: attempt.attempt,
    signal: () => signal,
    unmounted: () => unmountSignal?.aborted === true,
    restores: () => restores,
  };
}

function prepared(active: ActiveSessionReceipt, feature: string) {
  const execution = makePreparedExecution({
    projectDir: tmp,
    sessionId: SESSION_ID,
    feature,
    config: makeConfig(),
    active,
  });
  return { kind: 'prepared', execution } satisfies PreparationOutcome;
}

const claim = () => reactivateExistingSession({ projectDir: tmp, sessionId: SESSION_ID });

/** What Home does on submit: a newer start that hands off to a local run. */
function homeStart() {
  const outcome = Promise.withResolvers<PreparationOutcome>();
  const run = makeRunRecord({ ref: { projectDir: tmp, sessionId: SESSION_ID }, feature: 'ship B' });
  const handle = preparationStore.submit({
    origin: 'start',
    stage: 'Checking tools',
    prepare: () => outcome.promise,
    onPrepared: (execution) =>
      routerStore.navigate({
        to: 'workflow',
        run,
        execution: { kind: 'local', prepared: execution },
      }),
  });
  return { handle, outcome };
}

describe('runInteractiveStart while a newer start owns the mount', () => {
  it.each<[string, (launch: Awaited<ReturnType<typeof heldCliLaunch>>) => void]>([
    ['rejects', (launch) => launch.outcome.reject(new Error('A rejected'))],
    ['fails', (launch) => launch.outcome.resolve({ kind: 'failed', error: new Error('A failed') })],
    ['blocks', (launch) => launch.outcome.resolve({ kind: 'blocked', report: blockedReport(tmp) })],
  ])('keeps Home run B mounted and routed when CLI start A %s late', async (_label, settleA) => {
    const a = await heldCliLaunch();
    const b = homeStart();
    expect(a.signal()?.aborted).toBe(true);

    const outcomeB = prepared(claim(), 'ship B');
    b.outcome.resolve(outcomeB);
    await b.handle.promise;
    const routeB = routerStore.get();
    expect(routeB).toMatchObject({
      screen: 'workflow',
      execution: { kind: 'local', prepared: outcomeB.execution },
    });

    settleA(a);
    a.quit();
    await expect(a.run).resolves.toBeUndefined();

    expect(a.unmounted()).toBe(false);
    expect(a.restores()).toBe(0);
    expect(routerStore.get()).toBe(routeB);
    expect(preparationStore.get()).toEqual({ kind: 'idle' });
  });

  it('rolls back only its own receipt when CLI start A succeeds after Home start B began', async () => {
    const a = await heldCliLaunch();
    const b = homeStart();
    const receiptA = claim();
    const receiptB = claim();

    a.outcome.resolve(prepared(receiptA, 'ship A'));
    a.quit();
    await expect(a.run).resolves.toBeUndefined();

    expect(readActiveRecord(tmp)).toMatchObject({ kind: 'v1', receipt: receiptB });
    expect(routerStore.get().screen).toBe('home');
    expect(a.unmounted()).toBe(false);
    expect(preparationStore.get()).toMatchObject({ kind: 'checking', attempt: b.handle.attempt });
  });

  it('does not report or tear down for Home start B when B blocks before CLI start A fails', async () => {
    const a = await heldCliLaunch();
    const b = homeStart();

    b.outcome.resolve({ kind: 'blocked', report: blockedReport(tmp) });
    await b.handle.promise;
    a.outcome.reject(new Error('A rejected'));
    a.quit();
    await expect(a.run).resolves.toBeUndefined();

    expect(a.unmounted()).toBe(false);
    expect(preparationStore.get()).toMatchObject({ kind: 'blocked', attempt: b.handle.attempt });
  });

  it('leaves no local owner when the CLI attempt is cancelled before it prepares', async () => {
    const a = await heldCliLaunch();

    expect(preparationStore.cancel(a.attempt)).toBe(true);
    expect(a.signal()?.aborted).toBe(true);
    a.outcome.resolve(prepared(claim(), 'ship A'));
    a.quit();
    await expect(a.run).resolves.toBeUndefined();

    expect(readActive(tmp)).toBeNull();
    expect(routerStore.get().screen).toBe('home');
    expect(a.unmounted()).toBe(false);
    expect(preparationStore.get()).toEqual({ kind: 'idle' });
  });
});

describe('runInteractiveStart while it still owns the mount', () => {
  it('hands its prepared execution to a local run', async () => {
    const a = await heldCliLaunch();
    const outcomeA = prepared(claim(), 'ship A');

    a.outcome.resolve(outcomeA);
    a.quit();
    await expect(a.run).resolves.toBeUndefined();

    expect(routerStore.get()).toMatchObject({
      screen: 'workflow',
      execution: { kind: 'local', prepared: outcomeA.execution },
    });
    expect(a.unmounted()).toBe(false);
  });

  it.each<[string, (launch: Awaited<ReturnType<typeof heldCliLaunch>>) => void, RegExp]>([
    [
      'fails',
      (launch) => launch.outcome.resolve({ kind: 'failed', error: new Error('probe exploded') }),
      /probe exploded/u,
    ],
    [
      'rejects',
      (launch) => launch.outcome.reject(new Error('prepare crashed')),
      /prepare crashed/u,
    ],
  ])(
    'restores the terminal once and reports the error when it %s',
    async (_label, settleA, message) => {
      const a = await heldCliLaunch();

      settleA(a);
      await expect(a.run).rejects.toThrow(message);

      expect(a.restores()).toBe(1);
      expect(routerStore.get().screen).toBe('home');
    },
  );
});

function blockedReport(projectDir: string): ReadinessReport {
  return {
    generatedAt: '2026-08-10T00:00:00.000Z',
    projectDir,
    status: 'blocked',
    counts: { ok: 0, info: 0, warning: 0, blocker: 1 },
    nextAction: {
      kind: 'fix-config',
      label: 'Configure an implementer',
      reason: 'The default implementer is unreachable.',
    },
    sections: [
      {
        id: 'runners',
        title: 'Runners',
        checks: [
          {
            id: 'runners.availability.implementer.default',
            severity: 'blocker',
            summary: 'The default implementer is unreachable.',
          },
        ],
      },
    ],
    metadata: {},
  };
}
