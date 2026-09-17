import { describe, it, expect } from 'vitest';
import type { DetectedModel } from '../../core/discovery/detection.js';
import {
  APPLICATION_DEFAULT_CONTEXT_TOKENS,
  resolveApiRuntimeContext,
  type ApiRuntimeContext,
} from './runtime-context.js';
import type { SelectedProviderModelProbe } from './selected-model.js';

const CONTEXT_KEY = 'plan@http://127.0.0.1:1234';
const SELECTION_ID = 'qwen3-coder-30b@q4_k_m';

function found(model: Partial<DetectedModel>): SelectedProviderModelProbe {
  return {
    kind: 'found',
    contextKey: CONTEXT_KEY,
    selectionId: SELECTION_ID,
    model: { id: SELECTION_ID, ...model },
    observedAt: 1_700_000_000_000,
  };
}

function ready(options: {
  model?: Partial<DetectedModel>;
  configuredContextLength?: number;
}): ApiRuntimeContext {
  const resolution = resolveApiRuntimeContext({
    expectedContextKey: CONTEXT_KEY,
    expectedSelectionId: SELECTION_ID,
    observation: found(options.model ?? {}),
    configuredContextLength: options.configuredContextLength,
  });
  if (resolution.kind !== 'ready') {
    throw new Error(`expected a ready context, got ${resolution.code}: ${resolution.diagnostic}`);
  }
  return resolution.context;
}

describe('runtime context policy', () => {
  it('budgets against the observed active context and preserves every fact beside it', () => {
    const context = ready({
      model: {
        effectiveContextTokens: 4096,
        maximumContextTokens: 131_072,
        maximumOutputTokens: 32_768,
        runtime: { loadState: 'loaded', observedAt: 1_700_000_000_000 },
      },
      configuredContextLength: 32_768,
    });

    expect(context).toEqual({
      contextKey: CONTEXT_KEY,
      selectionId: SELECTION_ID,
      observedAt: 1_700_000_000_000,
      configuredContextTokens: 32_768,
      activeContextTokens: 4096,
      maximumContextTokens: 131_072,
      maximumOutputTokens: 32_768,
      applicationContextTokens: 4096,
      budgetSource: 'observed-active',
      loadState: 'loaded',
    });
  });

  it('falls back to the application assumption when nothing is known', () => {
    const context = ready({});

    expect(context.applicationContextTokens).toBe(APPLICATION_DEFAULT_CONTEXT_TOKENS);
    expect(context.applicationContextTokens).toBe(8192);
    expect(context.budgetSource).toBe('application-default');
    expect(context.loadState).toBe('unknown');
    expect(context.configuredContextTokens).toBeUndefined();
    expect(context.activeContextTokens).toBeUndefined();
    expect(context.maximumContextTokens).toBeUndefined();
    expect(context.maximumOutputTokens).toBeUndefined();
  });

  it('leaves the active context unknown when only an architectural maximum is reported', () => {
    const context = ready({ model: { maximumContextTokens: 131_072 } });

    expect(context.activeContextTokens).toBeUndefined();
    expect(context.maximumContextTokens).toBe(131_072);
    expect(context.applicationContextTokens).toBe(8192);
    expect(context.budgetSource).toBe('application-default');
  });

  it('never raises the fallback to 32768 to pass admission', () => {
    for (const model of [
      {},
      { maximumContextTokens: 131_072 },
      { maximumContextTokens: 32_768, maximumOutputTokens: 8192 },
    ]) {
      expect(ready({ model }).applicationContextTokens).toBe(8192);
    }
  });

  it('uses a larger known active context when no override configures one', () => {
    const context = ready({ model: { effectiveContextTokens: 32_768 } });

    expect(context.applicationContextTokens).toBe(32_768);
    expect(context.budgetSource).toBe('observed-active');
  });

  it('treats the architectural maximum as a ceiling on a configured budget', () => {
    const context = ready({
      model: { maximumContextTokens: 16_384 },
      configuredContextLength: 131_072,
    });

    expect(context.configuredContextTokens).toBe(131_072);
    expect(context.applicationContextTokens).toBe(16_384);
    expect(context.budgetSource).toBe('configured');
  });

  it('honours a configured budget that fits inside both the active context and the ceiling', () => {
    const context = ready({
      model: { effectiveContextTokens: 32_768, maximumContextTokens: 131_072 },
      configuredContextLength: 8192,
    });

    expect(context.applicationContextTokens).toBe(8192);
    expect(context.budgetSource).toBe('configured');
  });

  it.each([0, -4096, 4096.5, Number.NaN])(
    'ignores a configured context length of %s',
    (configuredContextLength) => {
      const context = ready({ model: { effectiveContextTokens: 16_384 }, configuredContextLength });

      expect(context.configuredContextTokens).toBeUndefined();
      expect(context.applicationContextTokens).toBe(16_384);
      expect(context.budgetSource).toBe('observed-active');
    },
  );

  it.each(['loaded', 'not-loaded', 'unknown'] as const)(
    'reports the observed %s state without inferring capacity from it',
    (loadState) => {
      const context = ready({
        model: { runtime: { loadState, observedAt: 1_700_000_000_000 } },
      });

      expect(context.loadState).toBe(loadState);
      expect(context.activeContextTokens).toBeUndefined();
    },
  );

  it.each([
    ['context key', { contextKey: 'review@http://127.0.0.1:11434' }],
    ['selection id', { selectionId: 'qwen3-coder-30b' }],
  ])('refuses an observation bound to another %s', (_label, rebind) => {
    const resolution = resolveApiRuntimeContext({
      expectedContextKey: CONTEXT_KEY,
      expectedSelectionId: SELECTION_ID,
      observation: { ...found({ effectiveContextTokens: 16_384 }), ...rebind },
    });

    expect(resolution).toMatchObject({ kind: 'unavailable', code: 'identity-mismatch' });
  });

  it('reports an unavailable selection when its own probe failed', () => {
    const resolution = resolveApiRuntimeContext({
      expectedContextKey: CONTEXT_KEY,
      expectedSelectionId: SELECTION_ID,
      observation: {
        kind: 'failed',
        contextKey: CONTEXT_KEY,
        selectionId: SELECTION_ID,
        failure: 'missing-model',
        diagnostic: `Provider catalog has no model with id "${SELECTION_ID}".`,
      },
      configuredContextLength: 32_768,
    });

    expect(resolution.kind).toBe('unavailable');
    if (resolution.kind !== 'unavailable') return;
    expect(resolution.code).toBe('selected-model-unavailable');
    expect(resolution.diagnostic).toContain('missing-model');
    expect(resolution.diagnostic).toContain(SELECTION_ID);
  });

  it('prefers the identity refusal over a failure that belongs to another selection', () => {
    const resolution = resolveApiRuntimeContext({
      expectedContextKey: CONTEXT_KEY,
      expectedSelectionId: SELECTION_ID,
      observation: {
        kind: 'failed',
        contextKey: 'review@http://127.0.0.1:11434',
        selectionId: 'llama3:8b',
        failure: 'offline',
        diagnostic: 'Connection refused.',
      },
    });

    expect(resolution).toMatchObject({ kind: 'unavailable', code: 'identity-mismatch' });
  });

  it('carries no credential into the resolved context or its diagnostics', () => {
    const context = ready({
      model: { effectiveContextTokens: 8192, maximumOutputTokens: 4096 },
      configuredContextLength: 8192,
    });

    expect(Object.keys(context).sort()).toEqual([
      'activeContextTokens',
      'applicationContextTokens',
      'budgetSource',
      'configuredContextTokens',
      'contextKey',
      'loadState',
      'maximumOutputTokens',
      'observedAt',
      'selectionId',
    ]);
  });
});
