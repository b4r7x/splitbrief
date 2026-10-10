import { describe, expect, it } from 'vitest';
import type { ProbeOutcome } from '../../../core/discovery/runner-evidence.js';
import type { DetectedModel } from '../../../core/discovery/detection.js';
import type {
  ScopedCliCatalogAttempt,
  ScopedCliCatalogRuntime,
} from '../../../engine/detection/cli-catalog-outcomes.js';
import type { CliModelSnapshot, DetectionSourceOutcome } from '../../../engine/detection/types.js';
import {
  cliCatalogValues,
  findCliCatalogRuntime,
  freezeCliCatalogs,
  reconciledCliCatalogs,
  REMEMBERED_CLI_CATALOG_CONTEXT,
} from './reconcile-cli-catalogs.js';

const CONNECTION = { tool: 'opencode', contextKey: 'planner|cli-executable-1' } as const;
const CAUSE = 'Server at http://127.0.0.1:49374 did not provide a compatible V2 health response';

function freshOutcome(
  outcome: ProbeOutcome<readonly DetectedModel[]>,
): DetectionSourceOutcome<CliModelSnapshot> {
  return catalogOutcome([{ connection: CONNECTION, outcome }]);
}

function catalogOutcome(
  attempts: readonly ScopedCliCatalogAttempt[],
): DetectionSourceOutcome<CliModelSnapshot> {
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

describe('reconciledCliCatalogs with successful reads', () => {
  const models = [{ id: 'model-a', displayName: 'A' }, { id: 'model-b' }];
  const initial: ScopedCliCatalogRuntime = {
    connection: CONNECTION,
    state: 'fresh',
    models,
    fetchedAt: 100,
    validatedAt: 100,
  };

  it('merges new rows and keeps a missing row stale until the next agreeing read', () => {
    const read = [{ id: 'model-c' }, { id: 'model-a', displayName: 'Updated A' }];
    const first = reconciledCliCatalogs({
      previous: [initial],
      outcome: freshOutcome({ kind: 'success', value: read }),
      observedAt: 200,
    });
    expect(first[0]).toMatchObject({
      state: 'stale',
      models: [...read, models[1]],
      missingOnce: ['model-b'],
      fetchedAt: 100,
      validatedAt: 200,
    });
    expect(first[0]).not.toHaveProperty('failure');

    const second = reconciledCliCatalogs({
      previous: first,
      outcome: freshOutcome({ kind: 'success', value: read }),
      observedAt: 300,
    });
    expect(second[0]).toMatchObject({
      state: 'fresh',
      models: read,
      fetchedAt: 300,
      validatedAt: 300,
    });
    expect(second[0]?.missingOnce ?? []).toEqual([]);
  });

  it('clears a missing mark when the next read returns the model', () => {
    const first = reconciledCliCatalogs({
      previous: [initial],
      outcome: freshOutcome({ kind: 'success', value: [{ id: 'model-a' }] }),
      observedAt: 200,
    });
    const second = reconciledCliCatalogs({
      previous: first,
      outcome: freshOutcome({ kind: 'success', value: models }),
      observedAt: 300,
    });
    expect(second[0]).toMatchObject({ state: 'fresh', models, fetchedAt: 300 });
    expect(second[0]?.missingOnce ?? []).toEqual([]);
  });

  it.each(['timeout', 'malformed', 'command-failed'] as const)(
    'preserves marks through a %s between two missing reads',
    (kind) => {
      const first = reconciledCliCatalogs({
        previous: [initial],
        outcome: freshOutcome({ kind: 'success', value: [{ id: 'model-a' }] }),
        observedAt: 200,
      });
      const failed = reconciledCliCatalogs({
        previous: first,
        outcome: freshOutcome(kind === 'command-failed' ? { kind, cause: CAUSE } : { kind }),
        observedAt: 300,
      });
      expect(failed[0]).toMatchObject({
        state: 'stale',
        models: [{ id: 'model-a' }, models[1]],
        missingOnce: ['model-b'],
        fetchedAt: 100,
        validatedAt: 300,
        failure: kind,
      });
      const second = reconciledCliCatalogs({
        previous: failed,
        outcome: freshOutcome({ kind: 'success', value: [{ id: 'model-a' }] }),
        observedAt: 400,
      });
      expect(second[0]).toMatchObject({
        state: 'fresh',
        models: [{ id: 'model-a' }],
        fetchedAt: 400,
      });
      expect(second[0]).not.toHaveProperty('failure');
      expect(second[0]).not.toHaveProperty('failureCause');
    },
  );

  it('keeps empty successes stale even after the second read removes all rows', () => {
    const first = reconciledCliCatalogs({
      previous: [initial],
      outcome: freshOutcome({ kind: 'success', value: [] }),
      observedAt: 200,
    });
    expect(first[0]).toMatchObject({
      state: 'stale',
      models,
      missingOnce: ['model-a', 'model-b'],
      fetchedAt: 100,
    });
    const second = reconciledCliCatalogs({
      previous: first,
      outcome: freshOutcome({ kind: 'success', value: [] }),
      observedAt: 300,
    });
    expect(second[0]).toMatchObject({
      state: 'stale',
      models: [],
      fetchedAt: 100,
      validatedAt: 300,
    });
    const cold = reconciledCliCatalogs({
      previous: [],
      outcome: freshOutcome({ kind: 'success', value: [] }),
      observedAt: 400,
    });
    expect(cold[0]).toMatchObject({ state: 'stale', models: [], fetchedAt: null });
  });

  it.each([{ missingOnce: undefined }, { missingOnce: ['model-b'] }])(
    'uses remembered rows and marks for the first live read ($missingOnce)',
    ({ missingOnce }) => {
      const remembered: ScopedCliCatalogRuntime = {
        ...initial,
        connection: { ...CONNECTION, contextKey: REMEMBERED_CLI_CATALOG_CONTEXT },
        state: 'stale',
        ...(missingOnce === undefined ? {} : { missingOnce }),
      };
      const next = reconciledCliCatalogs({
        previous: [remembered],
        outcome: freshOutcome({ kind: 'success', value: [{ id: 'model-a' }] }),
        observedAt: 200,
      });
      expect(next).toHaveLength(1);
      expect(next[0]).toMatchObject({
        connection: CONNECTION,
        state: missingOnce === undefined ? 'stale' : 'fresh',
        models: missingOnce === undefined ? [{ id: 'model-a' }, models[1]] : [{ id: 'model-a' }],
        fetchedAt: missingOnce === undefined ? 100 : 200,
      });
    },
  );

  it.each(['stale', 'failed'] as const)('preserves marks when the whole lane is %s', (kind) => {
    const next = reconciledCliCatalogs({
      previous: [{ ...initial, state: 'stale', missingOnce: ['model-b'] }],
      outcome:
        kind === 'failed'
          ? {
              kind,
              source: 'cli-models',
              contextKey: 'cli-models-context',
              generation: 2,
              requestId: 2,
              checkedAt: 200,
              error: { kind: 'timeout', message: 'Timed out.' },
            }
          : {
              kind,
              snapshot: {
                source: 'cli-models',
                contextKey: 'cli-models-context',
                generation: 2,
                requestId: 2,
                fetchedAt: 100,
                validatedAt: 200,
                stale: true,
                value: [],
                error: { kind: 'timeout', message: 'Timed out.' },
              },
            },
      observedAt: 200,
    });
    expect(next[0]).toMatchObject({
      state: 'stale',
      models,
      missingOnce: ['model-b'],
      fetchedAt: 100,
    });
  });

  it('clones and freezes missing marks with the runtime', () => {
    const missingOnce = ['model-b'];
    const frozen = freezeCliCatalogs([{ ...initial, state: 'stale', missingOnce }]);
    missingOnce.push('model-a');
    const runtime = Object.values(frozen)[0];
    expect(runtime?.missingOnce).toEqual(['model-b']);
    expect(Object.isFrozen(runtime?.missingOnce)).toBe(true);
    const [copy] = cliCatalogValues(frozen);
    expect(copy?.missingOnce).toEqual(['model-b']);
    expect(copy?.missingOnce).not.toBe(runtime?.missingOnce);
  });
});

describe('CLI catalog connection isolation', () => {
  const codex = { tool: 'codex', contextKey: 'codex-a' } as const;

  it('keeps failures and unread tools isolated while another tool adds rows', () => {
    const first = reconciledCliCatalogs({
      previous: [],
      observedAt: 100,
      outcome: catalogOutcome([
        { connection: codex, outcome: { kind: 'success', value: [{ id: 'codex-model' }] } },
        { connection: CONNECTION, outcome: { kind: 'success', value: [{ id: 'opencode-model' }] } },
      ]),
    });
    const second = reconciledCliCatalogs({
      previous: first,
      observedAt: 200,
      outcome: catalogOutcome([
        { connection: codex, outcome: { kind: 'offline' } },
        {
          connection: CONNECTION,
          outcome: {
            kind: 'success',
            value: [{ id: 'opencode-new-model' }, { id: 'opencode-model' }],
          },
        },
      ]),
    });
    expect(findCliCatalogRuntime(second, 'codex')).toMatchObject({
      state: 'stale',
      models: [{ id: 'codex-model' }],
      failure: 'offline',
    });
    expect(findCliCatalogRuntime(second, 'opencode')).toMatchObject({
      state: 'fresh',
      models: [{ id: 'opencode-new-model' }, { id: 'opencode-model' }],
    });
    const third = reconciledCliCatalogs({
      previous: second,
      observedAt: 300,
      outcome: freshOutcome({ kind: 'success', value: [] }),
    });
    expect(findCliCatalogRuntime(third, 'codex')).toEqual(findCliCatalogRuntime(second, 'codex'));
  });

  it('keeps a first malformed listing failed with no catalog', () => {
    const next = reconciledCliCatalogs({
      previous: [],
      observedAt: 100,
      outcome: freshOutcome({ kind: 'malformed' }),
    });
    expect(next[0]).toMatchObject({
      state: 'failed',
      models: null,
      fetchedAt: null,
      failure: 'malformed',
    });
  });

  it('drops an obsolete executable context instead of reusing its models', () => {
    const replacement = { ...CONNECTION, contextKey: 'replacement-executable' };
    const next = reconciledCliCatalogs({
      previous: [
        {
          connection: CONNECTION,
          state: 'fresh',
          models: [{ id: 'old-executable-model' }],
          fetchedAt: 100,
          validatedAt: 100,
        },
      ],
      observedAt: 200,
      outcome: catalogOutcome([{ connection: replacement, outcome: { kind: 'offline' } }]),
    });
    expect(next).toEqual([
      expect.objectContaining({
        connection: replacement,
        state: 'failed',
        models: null,
        failure: 'offline',
      }),
    ]);
    expect(JSON.stringify(next)).not.toContain('old-executable-model');
  });

  it('rejects an ambiguous tool lookup across two executables', () => {
    const next = reconciledCliCatalogs({
      previous: [],
      observedAt: 100,
      outcome: catalogOutcome([
        { connection: codex, outcome: { kind: 'success', value: [{ id: 'channel-a' }] } },
        {
          connection: { ...codex, contextKey: 'codex-b' },
          outcome: { kind: 'success', value: [{ id: 'channel-b' }] },
        },
        { connection: CONNECTION, outcome: { kind: 'success', value: [{ id: 'opencode-model' }] } },
      ]),
    });
    expect(findCliCatalogRuntime(next, 'codex')).toBeNull();
    expect(findCliCatalogRuntime(next, 'opencode')).toMatchObject({
      state: 'fresh',
      models: [{ id: 'opencode-model' }],
    });
  });
});

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
