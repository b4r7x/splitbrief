import { describe, expect, it } from 'vitest';
import {
  findConfiguredProviderRuntime,
  reconcileConfiguredProviderOutcomes,
  type ConfiguredProviderOutcome,
} from './provider-outcomes.js';

function outcome(input: {
  role: 'planner' | 'implementer';
  provider?: 'openai' | 'openrouter';
  contextKey: string;
  kind?: 'success' | 'failed';
  models?: readonly string[];
  failure?: 'privacy-filtered' | 'guardrail-filtered' | 'offline';
}): ConfiguredProviderOutcome {
  const provider = input.provider ?? 'openai';
  return {
    connection: { role: input.role, provider, contextKey: input.contextKey },
    outcome:
      input.kind === 'failed'
        ? {
            kind: 'failed',
            source: 'provider-runtime',
            provider,
            isLocal: false,
            credential: 'present',
            failure: input.failure ?? 'offline',
            diagnostic: 'Sanitized provider discovery failure.',
          }
        : {
            kind: 'success',
            source: 'provider-runtime',
            provider,
            isLocal: false,
            credential: 'present',
            catalog: (input.models ?? []).length === 0 ? 'empty' : 'populated',
            models: (input.models ?? []).map((id) => ({ id })),
          },
  };
}

describe('configured provider outcome reconciliation', () => {
  it('keeps same-provider role connections isolated and lets a valid empty snapshot clear only its own role', () => {
    const first = reconcileConfiguredProviderOutcomes({
      previous: [],
      outcomes: [
        outcome({ role: 'planner', contextKey: 'planner-alpha', models: ['planner-model'] }),
        outcome({
          role: 'implementer',
          contextKey: 'implementer-bravo',
          models: ['implementer-model'],
        }),
      ],
      observedAt: 100,
    });
    const next = reconcileConfiguredProviderOutcomes({
      previous: first,
      outcomes: [
        outcome({ role: 'planner', contextKey: 'planner-alpha', models: [] }),
        outcome({
          role: 'implementer',
          contextKey: 'implementer-bravo',
          models: ['implementer-model'],
        }),
      ],
      observedAt: 200,
    });

    expect(
      findConfiguredProviderRuntime(next, { role: 'planner', provider: 'openai' }),
    ).toMatchObject({
      state: 'fresh',
      catalog: 'empty',
      models: [],
      fetchedAt: 200,
    });
    expect(
      findConfiguredProviderRuntime(next, { role: 'implementer', provider: 'openai' }),
    ).toMatchObject({
      state: 'fresh',
      catalog: 'populated',
      models: [{ id: 'implementer-model' }],
      fetchedAt: 200,
    });
  });

  it('retains an exact last success as stale after a typed failure but leaves a first failure model-free', () => {
    const success = reconcileConfiguredProviderOutcomes({
      previous: [],
      outcomes: [outcome({ role: 'planner', contextKey: 'planner-alpha', models: ['last-good'] })],
      observedAt: 100,
    });
    const stale = reconcileConfiguredProviderOutcomes({
      previous: success,
      outcomes: [
        outcome({
          role: 'planner',
          contextKey: 'planner-alpha',
          kind: 'failed',
          failure: 'privacy-filtered',
        }),
        outcome({
          role: 'implementer',
          contextKey: 'implementer-bravo',
          kind: 'failed',
          failure: 'guardrail-filtered',
        }),
      ],
      observedAt: 200,
    });

    expect(
      findConfiguredProviderRuntime(stale, { role: 'planner', provider: 'openai' }),
    ).toMatchObject({
      state: 'stale',
      models: [{ id: 'last-good' }],
      fetchedAt: 100,
      validatedAt: 200,
      failure: 'privacy-filtered',
    });
    expect(
      findConfiguredProviderRuntime(stale, { role: 'implementer', provider: 'openai' }),
    ).toMatchObject({
      state: 'failed',
      models: null,
      failure: 'guardrail-filtered',
      fetchedAt: null,
      validatedAt: 200,
    });
  });

  it('does not retain models across a changed connection context', () => {
    const previous = reconcileConfiguredProviderOutcomes({
      previous: [],
      outcomes: [
        outcome({ role: 'planner', contextKey: 'planner-alpha', models: ['old-connection'] }),
      ],
      observedAt: 100,
    });
    const next = reconcileConfiguredProviderOutcomes({
      previous,
      outcomes: [
        outcome({
          role: 'planner',
          contextKey: 'planner-bravo',
          kind: 'failed',
          failure: 'offline',
        }),
      ],
      observedAt: 200,
    });

    expect(
      findConfiguredProviderRuntime(next, { role: 'planner', provider: 'openai' }),
    ).toMatchObject({
      connection: { contextKey: 'planner-bravo' },
      state: 'failed',
      models: null,
    });
  });
});
