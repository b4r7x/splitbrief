import { beforeEach, describe, expect, it } from 'vitest';
import { modelCacheStore } from './state.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import type { ConfiguredProviderOutcome } from '../../../engine/detection/provider-outcomes.js';
import type {
  DetectionRefreshOutcomes,
  DetectionServiceResult,
} from '../../../engine/detection/service.js';

const contexts = {
  readiness: 'reviewer-scope-readiness',
  modelsDev: 'reviewer-scope-models-dev',
  cliModels: 'reviewer-scope-cli-models',
};

/** Every seat here is `ollama`, so only role and context key separate the rows. */
function seatOutcome(
  input: Readonly<{
    role: ActiveRunnerRole;
    contextKey: string;
    models?: readonly string[] | undefined;
    failure?: 'offline' | 'invalid-credential' | undefined;
  }>,
): ConfiguredProviderOutcome {
  return {
    connection: { role: input.role, provider: 'ollama', contextKey: input.contextKey },
    outcome:
      input.failure === undefined
        ? {
            kind: 'success',
            source: 'provider-runtime',
            provider: 'ollama',
            isLocal: true,
            credential: 'present',
            catalog: (input.models ?? []).length === 0 ? 'empty' : 'populated',
            models: (input.models ?? []).map((id) => ({ id })),
          }
        : {
            kind: 'failed',
            source: 'provider-runtime',
            provider: 'ollama',
            isLocal: true,
            credential: 'present',
            failure: input.failure,
            diagnostic: 'Sanitized catalog failure.',
          },
  };
}

function result(
  configuredProviderOutcomes: readonly ConfiguredProviderOutcome[],
  generation: number,
): DetectionServiceResult & { readonly outcomes: DetectionRefreshOutcomes } {
  const snapshot = {
    source: 'readiness' as const,
    contextKey: contexts.readiness,
    generation,
    requestId: generation,
    fetchedAt: generation * 100,
    validatedAt: generation * 100,
    stale: false as const,
    value: { providers: [], cliTools: [], configuredProviderOutcomes },
  };
  return {
    providers: [],
    cliTools: [],
    configuredProviderOutcomes,
    catalog: null,
    cliModels: [],
    generation,
    outcomes: {
      readiness: { kind: 'fresh', origin: 'request', snapshot },
      modelsDev: {
        kind: 'not-run',
        source: 'models-dev',
        contextKey: contexts.modelsDev,
        reason: 'uninitialized',
      },
      cliModels: {
        kind: 'not-run',
        source: 'cli-models',
        contextKey: contexts.cliModels,
        reason: 'uninitialized',
      },
    },
  };
}

function publish(outcomes: readonly ConfiguredProviderOutcome[], generation: number): void {
  const request = modelCacheStore.beginRefresh({ contexts });
  expect(modelCacheStore.publish({ result: result(outcomes, generation), request })).toBe(true);
}

function runtime(role: ActiveRunnerRole) {
  return modelCacheStore.getScopedProviderRuntime({ role, provider: 'ollama' });
}

describe('reviewer seat cache scope', () => {
  beforeEach(() => {
    modelCacheStore.reset();
  });

  it('never answers a distinct REVIEW endpoint with the PLAN catalog', () => {
    publish(
      [
        seatOutcome({ role: 'planner', contextKey: 'plan-11434', models: ['plan-model:8b'] }),
        seatOutcome({ role: 'reviewer', contextKey: 'review-11436', models: ['review-model:8b'] }),
      ],
      1,
    );

    expect(runtime('reviewer')).toMatchObject({
      connection: { role: 'reviewer', contextKey: 'review-11436' },
      state: 'fresh',
      models: [{ id: 'review-model:8b' }],
    });
    expect(runtime('planner')).toMatchObject({
      connection: { role: 'planner', contextKey: 'plan-11434' },
      state: 'fresh',
      models: [{ id: 'plan-model:8b' }],
    });
  });

  it('keeps a failed REVIEW refresh on the same context stale with its own last catalog', () => {
    publish(
      [
        seatOutcome({ role: 'planner', contextKey: 'plan-11434', models: ['plan-model:8b'] }),
        seatOutcome({ role: 'reviewer', contextKey: 'review-11436', models: ['review-model:8b'] }),
      ],
      1,
    );
    publish(
      [
        seatOutcome({ role: 'planner', contextKey: 'plan-11434', models: ['plan-model:8b'] }),
        seatOutcome({ role: 'reviewer', contextKey: 'review-11436', failure: 'offline' }),
      ],
      2,
    );

    expect(runtime('reviewer')).toMatchObject({
      state: 'stale',
      models: [{ id: 'review-model:8b' }],
      fetchedAt: 100,
      validatedAt: 200,
      failure: 'offline',
    });
  });

  it('borrows nothing when the REVIEW connection context changes', () => {
    publish(
      [
        seatOutcome({ role: 'planner', contextKey: 'plan-11434', models: ['plan-model:8b'] }),
        seatOutcome({ role: 'reviewer', contextKey: 'review-11436', models: ['review-model:8b'] }),
      ],
      1,
    );
    publish(
      [
        seatOutcome({ role: 'planner', contextKey: 'plan-11434', models: ['plan-model:8b'] }),
        seatOutcome({
          role: 'reviewer',
          contextKey: 'review-11437',
          failure: 'invalid-credential',
        }),
      ],
      2,
    );

    expect(runtime('reviewer')).toMatchObject({
      connection: { contextKey: 'review-11437' },
      state: 'failed',
      catalog: null,
      models: null,
      fetchedAt: null,
      failure: 'invalid-credential',
    });
    expect(runtime('planner')).toMatchObject({ models: [{ id: 'plan-model:8b' }] });
  });

  it('lets an empty REVIEW success replace the models it last held', () => {
    publish(
      [seatOutcome({ role: 'reviewer', contextKey: 'review-11436', models: ['gone:8b'] })],
      1,
    );
    publish([seatOutcome({ role: 'reviewer', contextKey: 'review-11436', models: [] })], 2);

    expect(runtime('reviewer')).toMatchObject({
      state: 'fresh',
      catalog: 'empty',
      models: [],
      fetchedAt: 200,
    });
  });

  it('reads an absent reviewer block from its explicit planner-derived outcome, not from PLAN', () => {
    // What discovery publishes when the config carries no `reviewer:` block:
    // one request, two outcomes, the reviewer's under its own identity.
    publish(
      [
        seatOutcome({ role: 'planner', contextKey: 'plan-11434', models: ['plan-model:8b'] }),
        seatOutcome({ role: 'reviewer', contextKey: 'review-derived', models: ['plan-model:8b'] }),
      ],
      1,
    );

    expect(runtime('reviewer')).toMatchObject({
      connection: { role: 'reviewer', contextKey: 'review-derived' },
      state: 'fresh',
      models: [{ id: 'plan-model:8b' }],
    });
  });

  it('reports authoritative absence rather than inferring PLAN when no reviewer outcome lands', () => {
    publish(
      [seatOutcome({ role: 'planner', contextKey: 'plan-11434', models: ['plan-model:8b'] })],
      1,
    );

    expect(runtime('reviewer')).toBeNull();
    expect(runtime('planner')).toMatchObject({ models: [{ id: 'plan-model:8b' }] });
  });
});
