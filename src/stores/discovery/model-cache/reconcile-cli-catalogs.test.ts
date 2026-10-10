import { describe, expect, it } from 'vitest';
import type { ProbeOutcome } from '../../../core/discovery/runner-evidence.js';
import type { DetectedModel } from '../../../core/discovery/detection.js';
import type {
  ScopedCliCatalogAttempt,
  ScopedCliCatalogRuntime,
} from '../../../engine/detection/cli-catalog-outcomes.js';
import type { CliModelSnapshot, DetectionSourceOutcome } from '../../../engine/detection/types.js';
import { reconciledCliCatalogs } from './reconcile-cli-catalogs.js';

const CONNECTION = { tool: 'opencode', contextKey: 'planner|cli-executable-1' } as const;
const CAUSE = 'Server at http://127.0.0.1:49374 did not provide a compatible V2 health response';

function freshOutcome(
  outcome: ProbeOutcome<readonly DetectedModel[]>,
): DetectionSourceOutcome<CliModelSnapshot> {
  const attempts: readonly ScopedCliCatalogAttempt[] = [{ connection: CONNECTION, outcome }];
  return {
    kind: 'fresh',
    origin: 'request',
    snapshot: {
      source: 'cli-models',
      contextKey: 'cli-models-context',
      generation: 1,
      requestId: 1,
      fetchedAt: 500,
      validatedAt: 500,
      stale: false,
      value: attempts,
    },
  };
}

describe('reconciledCliCatalogs with a failed listing command', () => {
  it('records the cause beside the failure when no earlier rows exist', () => {
    const [runtime] = reconciledCliCatalogs({
      previous: [],
      outcome: freshOutcome({ kind: 'command-failed', cause: CAUSE }),
      observedAt: 500,
    });

    expect(runtime).toEqual({
      connection: CONNECTION,
      state: 'failed',
      models: null,
      fetchedAt: null,
      validatedAt: 500,
      failure: 'command-failed',
      failureCause: CAUSE,
    });
  });

  it('keeps the earlier rows as stale and still carries the cause', () => {
    const previous: ScopedCliCatalogRuntime = {
      connection: CONNECTION,
      state: 'fresh',
      models: [{ id: 'opencode-go/deepseek-v4.1-flash', nativeOrder: 0 }],
      fetchedAt: 100,
      validatedAt: 100,
    };

    const [runtime] = reconciledCliCatalogs({
      previous: [previous],
      outcome: freshOutcome({ kind: 'command-failed', cause: CAUSE }),
      observedAt: 500,
    });

    expect(runtime).toEqual({
      connection: CONNECTION,
      state: 'stale',
      models: [{ id: 'opencode-go/deepseek-v4.1-flash', nativeOrder: 0 }],
      fetchedAt: 100,
      validatedAt: 500,
      failure: 'command-failed',
      failureCause: CAUSE,
    });
  });

  it('drops an earlier cause once a later listing fails for another reason', () => {
    const previous: ScopedCliCatalogRuntime = {
      connection: CONNECTION,
      state: 'stale',
      models: [{ id: 'opencode-go/deepseek-v4.1-flash', nativeOrder: 0 }],
      fetchedAt: 100,
      validatedAt: 400,
      failure: 'command-failed',
      failureCause: CAUSE,
    };

    const [runtime] = reconciledCliCatalogs({
      previous: [previous],
      outcome: freshOutcome({ kind: 'timeout' }),
      observedAt: 500,
    });

    expect(runtime?.failure).toBe('timeout');
    expect(runtime).not.toHaveProperty('failureCause');
  });

  it.each(['failed', 'stale'] as const)(
    'replaces the cause of a failed runtime when the whole listing lane later fails (%s outcome)',
    (kind) => {
      const previous: ScopedCliCatalogRuntime = {
        connection: CONNECTION,
        state: 'failed',
        models: null,
        fetchedAt: null,
        validatedAt: 400,
        failure: 'command-failed',
        failureCause: CAUSE,
      };

      const [runtime] = reconciledCliCatalogs({
        previous: [previous],
        outcome:
          kind === 'failed'
            ? {
                kind,
                source: 'cli-models',
                contextKey: 'cli-models-context',
                generation: 2,
                requestId: 2,
                checkedAt: 500,
                error: { kind: 'timeout', message: 'CLI model discovery timed out.' },
              }
            : {
                kind,
                snapshot: {
                  source: 'cli-models',
                  contextKey: 'cli-models-context',
                  generation: 2,
                  requestId: 2,
                  fetchedAt: 400,
                  validatedAt: 500,
                  stale: true,
                  value: [],
                  error: { kind: 'timeout', message: 'CLI model discovery timed out.' },
                },
              },
        observedAt: 500,
      });

      expect(runtime).toEqual({
        connection: CONNECTION,
        state: 'failed',
        models: null,
        fetchedAt: null,
        validatedAt: 500,
        failure: 'timeout',
      });
    },
  );
});
