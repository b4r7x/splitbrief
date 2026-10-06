import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createApiPlanner, invokeApiTransport } from '../planners/api.js';
import { apiBuildTargets, estimateBundleOutputReserve } from './api-budget.js';
import { readApiContextDiagnostic } from './api-context-diagnostic.js';
import { apiConnectionContextKey } from './selected-model.js';

function config(provider = 'lm-studio', contextLength?: number) {
  return makeConfig({
    planner: {
      kind: 'api',
      provider,
      model: 'fixture-model',
      apiBase: 'http://127.0.0.1:1234/v1',
      apiKey: 'fixture-only',
      ...(contextLength === undefined ? {} : { contextLength }),
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('API planning wire budgets', () => {
  it.each(['planner', 'reviewer'] as const)(
    'keeps a late %s output-cap refusal typed and qualitative',
    async (seat) => {
      const provider = 'fixture-custom';
      const apiBase = 'http://127.0.0.1:1234/v1';
      const create = vi.fn(async (): Promise<never> => {
        throw new Error('must not dispatch');
      });
      let failure: unknown;
      try {
        await invokeApiTransport({
          client: { chat: { completions: { create } } },
          model: 'fixture-model',
          prepared: {
            seat,
            provider,
            apiBase,
            overrides: { apiBase },
            selectionId: 'fixture-model',
          },
          planner: { provider, apiBase, apiKey: 'fixture-only' },
          prompt: 'Review.',
          onOutput() {},
          totalDeadlineMs: 1000,
          callContext: {
            callId: 'fixture',
            role: seat === 'planner' ? 'planner' : 'review',
            backendKind: 'api',
          },
          apiContext: {
            contextKey: apiConnectionContextKey(provider, apiBase),
            selectionId: 'fixture-model',
            observedAt: Date.now(),
            applicationContextTokens: 32_768,
            maximumOutputTokens: 1_024,
            budgetSource: 'observed-active',
            loadState: 'loaded',
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(readApiContextDiagnostic(failure)).toMatchObject({
        seat: seat === 'planner' ? 'plan' : 'review',
        cause: 'output-budget',
        requiredOutputTokens: 2_048,
        outputCap: 1_024,
        budgetSource: 'observed-active',
        omittedRequestOptions: ['temperature', 'stream_options.include_usage'],
      });
      if (!(failure instanceof Error)) throw new Error('expected typed refusal');
      expect(failure.message).not.toMatch(/\d/);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each(['planner', 'reviewer'] as const)(
    'refuses a custom %s endpoint below the mandatory reserve without dispatch',
    async (seat) => {
      const fetch = vi.fn(() => {
        throw new Error('unexpected external request');
      });
      vi.stubGlobal('fetch', fetch);
      const planner = createApiPlanner(config('fixture-custom', 512), seat);
      let failure: unknown;
      try {
        await planner.review('Review.', '/tmp', { onOutput() {} });
      } catch (error) {
        failure = error;
      }
      expect(readApiContextDiagnostic(failure)).toMatchObject({
        seat: seat === 'planner' ? 'plan' : 'review',
        cause: 'input-budget',
        requiredOutputTokens: 2_048,
      });
      expect(failure).toBeInstanceOf(Error);
      if (failure instanceof Error) expect(failure.message).not.toMatch(/\d/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('reserves empty existing files as modifications and absent files as creations', () => {
    const targets = apiBuildTargets(
      makeTask({
        action: 'modify',
        currentCode: '',
        suggestedFiles: ['empty.ts', 'other.ts', 'new.ts'],
        currentCodeByFile: { 'other.ts': '' },
      }),
    );
    expect(targets).toEqual([
      { path: 'empty.ts', action: 'modify', content: '' },
      { path: 'other.ts', action: 'modify', content: '' },
      { path: 'new.ts', action: 'create' },
    ]);
    expect(estimateBundleOutputReserve(targets)).toBeLessThan(4_096);
  });
});
