import { beforeEach, describe, it, expect } from 'vitest';
import { createRuntimeCommands } from './registry.js';
import { makeCtx, noop, executeRuntimeCommand } from '#testing/helpers/runtime-commands.js';
import type { DiscoveryRefreshSummary, RuntimeConfigSaveResult } from './types.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache.js';

function failedRefreshSummary(
  status: 'fresh' | 'partial' | 'stale' | 'failed' | 'not-run' | 'uninitialized' | 'superseded',
) {
  const lanes: DiscoveryRefreshSummary['lanes'] =
    status === 'fresh'
      ? {
          readiness: { outcome: 'fresh' },
          modelsDev: { outcome: 'fresh' },
          cliModels: { outcome: 'fresh' },
        }
      : status === 'partial'
        ? {
            readiness: { outcome: 'fresh' },
            modelsDev: { outcome: 'failed' },
            cliModels: { outcome: 'fresh' },
          }
        : status === 'stale'
          ? {
              readiness: { outcome: 'stale' },
              modelsDev: { outcome: 'failed' },
              cliModels: { outcome: 'stale' },
            }
          : status === 'failed'
            ? {
                readiness: { outcome: 'failed' },
                modelsDev: { outcome: 'failed' },
                cliModels: { outcome: 'failed' },
              }
            : status === 'not-run'
              ? {
                  readiness: { outcome: 'not-run', reason: 'offline' },
                  modelsDev: { outcome: 'not-run', reason: 'offline' },
                  cliModels: { outcome: 'not-run', reason: 'offline' },
                }
              : status === 'superseded'
                ? {
                    readiness: { outcome: 'not-run', reason: 'superseded' },
                    modelsDev: { outcome: 'not-run', reason: 'superseded' },
                    cliModels: { outcome: 'not-run', reason: 'superseded' },
                  }
                : {
                    readiness: { outcome: 'not-run', reason: 'uninitialized' },
                    modelsDev: { outcome: 'not-run', reason: 'uninitialized' },
                    cliModels: { outcome: 'not-run', reason: 'uninitialized' },
                  };
  return {
    status,
    published: status !== 'not-run' && status !== 'uninitialized' && status !== 'superseded',
    lanes,
  };
}

describe('/mode command', () => {
  it('opens mode-selector overlay when called without args', async () => {
    let openedOverlay: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        openOverlay: (type) => {
          openedOverlay = type;
        },
      }),
    );
    await executeRuntimeCommand(commands, '/mode', 'home', noop);
    expect(openedOverlay).toBe('mode-selector');
  });

  it('shows success only after a saved mode result resolves', async () => {
    let savedMode: string | undefined;
    let feedback: string | undefined;
    let openedOverlay: string | undefined;
    const saved = Promise.withResolvers<RuntimeConfigSaveResult>();
    const commands = createRuntimeCommands(
      makeCtx({
        openOverlay: (type) => {
          openedOverlay = type;
        },
        setWorkflowMode: (m) => {
          savedMode = m;
          return saved.promise;
        },
        setFeedbackMessage: (m) => {
          feedback = m;
        },
      }),
    );
    const execution = executeRuntimeCommand(commands, '/mode quick', 'home', noop);

    expect(savedMode).toBe('quick');
    expect(feedback).toBeUndefined();
    expect(openedOverlay).toBeUndefined();

    saved.resolve({ kind: 'saved', ok: true });
    await execution;

    expect(feedback).toMatch(/quick/);
  });

  it('sets mode to speckit after persistence succeeds', async () => {
    let savedMode: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        setWorkflowMode: (m) => {
          savedMode = m;
          return Promise.resolve({ kind: 'saved', ok: true });
        },
      }),
    );
    await executeRuntimeCommand(commands, '/mode speckit', 'home', noop);
    expect(savedMode).toBe('speckit');
  });

  it.each(['conflict', 'durability-uncertain', 'failure'] as const)(
    'does not show success feedback when mode persistence resolves %s',
    async (kind) => {
      let feedback: string | undefined;
      const completion = Promise.withResolvers<RuntimeConfigSaveResult>();
      const commands = createRuntimeCommands(
        makeCtx({
          setWorkflowMode: () => completion.promise,
          setFeedbackMessage: (m) => {
            feedback = m;
          },
        }),
      );
      const execution = executeRuntimeCommand(commands, '/mode quick', 'home', noop);

      expect(feedback).toBeUndefined();
      completion.resolve({ kind, ok: false });
      await execution;

      expect(feedback).toBeUndefined();
    },
  );

  it('rejects invalid mode and surfaces an error', async () => {
    let savedMode: string | undefined;
    let error: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        setWorkflowMode: (m) => {
          savedMode = m;
          return Promise.resolve({ kind: 'saved', ok: true });
        },
        setFeedbackError: (m) => {
          error = m;
        },
      }),
    );
    await executeRuntimeCommand(commands, '/mode turbo', 'home', noop);
    expect(savedMode).toBeUndefined();
    expect(error).toMatch(/invalid/i);
  });
});

describe('/effort command', () => {
  it('shows success only after a saved effort result resolves', async () => {
    let savedEffort: string | undefined;
    let feedback: string | undefined;
    const saved = Promise.withResolvers<RuntimeConfigSaveResult>();
    const commands = createRuntimeCommands(
      makeCtx({
        setPlannerEffort: (effort) => {
          savedEffort = effort;
          return saved.promise;
        },
        setFeedbackMessage: (message) => {
          feedback = message;
        },
      }),
    );
    const execution = executeRuntimeCommand(commands, '/effort high', 'home', noop);

    expect(savedEffort).toBe('high');
    expect(feedback).toBeUndefined();

    saved.resolve({ kind: 'saved', ok: true });
    await execution;

    expect(feedback).toMatch(/high/);
  });

  it.each(['conflict', 'durability-uncertain', 'failure'] as const)(
    'does not show success feedback when effort persistence resolves %s',
    async (kind) => {
      let feedback: string | undefined;
      const completion = Promise.withResolvers<RuntimeConfigSaveResult>();
      const commands = createRuntimeCommands(
        makeCtx({
          setPlannerEffort: () => completion.promise,
          setFeedbackMessage: (message) => {
            feedback = message;
          },
        }),
      );
      const execution = executeRuntimeCommand(commands, '/effort medium', 'home', noop);

      expect(feedback).toBeUndefined();
      completion.resolve({ kind, ok: false });
      await execution;

      expect(feedback).toBeUndefined();
    },
  );
});

describe('/refresh command', () => {
  beforeEach(() => {
    modelCacheStore.reset();
  });

  it('runs detection and surfaces a status message to the user', async () => {
    let refreshRan = false;
    const messages: string[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        refreshDetection: async () => {
          refreshRan = true;
          return {
            status: 'fresh',
            published: true,
            lanes: {
              readiness: { outcome: 'fresh' },
              modelsDev: { outcome: 'fresh' },
              cliModels: { outcome: 'fresh' },
            },
          };
        },
        setFeedbackMessage: (m) => {
          messages.push(m);
        },
      }),
    );
    await executeRuntimeCommand(commands, '/refresh', 'home', noop);
    expect(refreshRan).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
  });

  it.each([
    ['partial', 'Tool detection refresh completed with partial results'],
    ['stale', 'Tool detection refresh kept stale results'],
    ['failed', 'Tool detection refresh failed'],
    ['not-run', 'Tool detection refresh was not run'],
    ['uninitialized', 'Tool detection refresh is not initialized'],
    ['superseded', 'Tool detection refresh was superseded'],
  ] as const)('does not report success when discovery is %s', async (status, message) => {
    const errors: string[] = [];
    const messages: string[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        refreshDetection: async () => failedRefreshSummary(status),
        setFeedbackError: (value) => errors.push(value),
        setFeedbackMessage: (value) => messages.push(value),
      }),
    );

    await executeRuntimeCommand(commands, '/refresh', 'home', noop);

    expect(errors).toEqual([message]);
    expect(messages).not.toContain('Tool detection refreshed');
  });

  it('reports a first-ever all-lane failure without claiming that prior results were retained', async () => {
    const errors: string[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        refreshDetection: async () => failedRefreshSummary('failed'),
        setFeedbackError: (message) => errors.push(message),
      }),
    );

    await executeRuntimeCommand(commands, '/refresh', 'home', noop);

    expect(errors).toEqual(['Tool detection refresh failed']);
  });

  it('reports a same-context overlapping refresh as superseded without inventing a settings change', async () => {
    const errors: string[] = [];
    const messages: string[] = [];
    const firstRefresh = Promise.withResolvers<DiscoveryRefreshSummary>();
    let refreshes = 0;
    const commands = createRuntimeCommands(
      makeCtx({
        refreshDetection: async () => {
          refreshes += 1;
          return refreshes === 1 ? firstRefresh.promise : failedRefreshSummary('fresh');
        },
        setFeedbackError: (message) => errors.push(message),
        setFeedbackMessage: (message) => messages.push(message),
      }),
    );

    const first = executeRuntimeCommand(commands, '/refresh', 'home', noop);
    const second = executeRuntimeCommand(commands, '/refresh', 'home', noop);
    firstRefresh.resolve(failedRefreshSummary('superseded'));
    await Promise.all([first, second]);

    expect(errors).toContain('Tool detection refresh was superseded');
    expect(messages).toContain('Tool detection refreshed');
  });
});

describe('/planner command', () => {
  it('opens the planner-picker overlay', () => {
    let openedOverlay: string | undefined;
    const commands = createRuntimeCommands(
      makeCtx({
        openOverlay: (type) => {
          openedOverlay = type;
        },
      }),
    );
    executeRuntimeCommand(commands, '/planner', 'home', noop);
    expect(openedOverlay).toBe('planner-picker');
  });
});

describe('/reviewer and /crew commands', () => {
  it('open the reviewer-picker and crew overlays', () => {
    const opened: string[] = [];
    const commands = createRuntimeCommands(
      makeCtx({
        openOverlay: (type) => {
          opened.push(type);
        },
      }),
    );

    executeRuntimeCommand(commands, '/reviewer', 'home', noop);
    executeRuntimeCommand(commands, '/crew', 'home', noop);

    expect(opened).toEqual(['reviewer-picker', 'crew']);
  });
});
