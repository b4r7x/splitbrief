import { afterEach, beforeEach, expect, it } from 'vitest';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import {
  formatRecordedSeatChangeIdentities,
  formatRecordedSeatIdentity,
} from './recorded-seat-identity.js';

beforeEach(() => {
  modelCacheStore.reset();
  modelCacheStore.hydrateDetection({
    providers: [],
    cliTools: [],
    fetchedAt: 1,
    validatedAt: 1,
    generation: 0,
    requestId: 0,
    contexts: { readiness: 'readiness', modelsDev: 'catalog', cliModels: 'tools' },
    cliCatalogs: [
      { tool: 'codex', probedAt: 1, models: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }] },
    ],
  });
});

afterEach(() => modelCacheStore.reset());

it('uses the catalog label for a recorded seat and preserves its effort', () => {
  expect(
    formatRecordedSeatIdentity({
      runnerName: 'codex',
      model: 'gpt-6-luna',
      backendKind: 'cli',
      axes: ['high'],
      role: 'implementer',
    }),
  ).toBe('OpenAI Codex CLI · GPT-6-Luna · high');
  expect(formatRecordedSeatIdentity({ role: 'planner' })).toBeNull();
});

it('uses the same catalog label on both sides of a seat change', () => {
  expect(
    formatRecordedSeatChangeIdentities(
      { tool: 'codex', model: 'gpt-6-luna', effort: 'low' },
      { tool: 'codex', model: 'gpt-6-luna', effort: 'high' },
      'implementer',
    ),
  ).toEqual({
    from: 'OpenAI Codex CLI · GPT-6-Luna · low',
    to: 'OpenAI Codex CLI · GPT-6-Luna · high',
  });
});
