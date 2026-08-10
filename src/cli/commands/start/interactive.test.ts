import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realpathSync } from 'node:fs';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { writeConfigMarker, prepareExecutionMock } from '#testing/helpers/start-command.js';
import { saveDetectionCache } from '../../../engine/detection/cache.js';
import * as capabilitiesModule from '../../../engine/providers/capabilities.js';
import * as initStoresModule from '../../init-stores.js';
import * as setupModule from '../../setup.js';
import { COLD_START_STDERR_LINE } from '../../../core/discovery/copy.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import { runInteractiveStart } from './interactive.js';
import * as readinessModule from './readiness.js';
import type { InteractiveDispatchArgs, StartDeps } from './types.js';

setupFetchMock();

let tmp = '';

const renderAppFake: StartDeps['renderApp'] = async () => {};

beforeEach(() => {
  vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('{}', { status: 200 }));
  tmp = realpathSync(createTempDir('interactive-start-test'));
  createTestGitRepo(tmp);
  writeConfigMarker(tmp);
  resetAllStores();
  process.stdin.isTTY = true;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (tmp) cleanupTempDir(tmp);
  delete (process.stdin as { isTTY?: boolean }).isTTY;
});

function makeDispatch(overrides: Partial<InteractiveDispatchArgs> = {}): InteractiveDispatchArgs {
  const deps: StartDeps = {
    spawnServer: vi.fn(),
    runHeadless: vi.fn(),
    runRpc: vi.fn(),
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
    handOffWorktree: () => {},
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

    let renderStarted = false;
    const renderApp: StartDeps['renderApp'] = async () => {
      renderStarted = true;
    };

    const run = runInteractiveStart(
      makeDispatch({
        deps: {
          spawnServer: vi.fn(),
          runHeadless: vi.fn(),
          runRpc: vi.fn(),
          initStores: async () => {},
          renderApp,
          prepareExecution: prepareExecutionMock,
        },
      }),
    );

    await vi.waitFor(() => expect(renderStarted).toBe(true));

    discoveryGate.resolve();
    await run;
  });

  it('unmounts the TUI before a readiness blocker reaches the terminal (T-037)', async () => {
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
          spawnServer: vi.fn(),
          runHeadless: vi.fn(),
          runRpc: vi.fn(),
          initStores: async () => {},
          renderApp,
          prepareExecution: async () => ({ kind: 'blocked', report: blockedReport(tmp) }),
        },
      }),
    );

    await expect(run).rejects.toThrow(/Run readiness blocked/u);
    expect(events).toEqual(['mounted', 'restored', 'blockers']);
  });

  it('keeps a created worktree rollback-eligible when preparation is blocked', async () => {
    const handOffWorktree = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const run = runInteractiveStart(
      makeDispatch({
        feature: 'ship it',
        handOffWorktree,
        deps: {
          spawnServer: vi.fn(),
          runHeadless: vi.fn(),
          runRpc: vi.fn(),
          initStores: async () => {},
          renderApp: renderAppFake,
          prepareExecution: async () => ({ kind: 'blocked', report: blockedReport(tmp) }),
        },
      }),
    );

    await expect(run).rejects.toThrow(/Run readiness blocked/u);
    expect(handOffWorktree).not.toHaveBeenCalled();
  });
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
