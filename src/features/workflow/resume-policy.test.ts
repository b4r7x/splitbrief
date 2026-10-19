import { afterEach, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { resolveSeatDisplayName } from '../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { runResumePolicy } from './resume-policy.js';

afterEach(() => modelCacheStore.reset());

it('retains run permissions and resolves resumed seat labels from the current catalog', () => {
  const runner = { kind: 'cli', tool: 'codex', model: 'gpt-6-luna' } as const;
  const prepared = makePreparedExecution({
    projectDir: '/project',
    sessionId: 'resume',
    feature: 'catalog names',
    config: makeConfig({ planner: runner }),
    allowHooks: true,
  });
  const policy = runResumePolicy(prepared.runtime);
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

  expect(policy).toMatchObject({
    purpose: 'resume',
    interaction: 'interactive',
    unverifiedAuth: 'disclosed',
    allowHooks: true,
    allowRepoRunners: false,
  });
  if (policy.modelCache === undefined) throw new Error('Expected the resume catalog');
  expect(resolveSeatDisplayName(runner, 'planner', policy.modelCache)).toBe('GPT-6-Luna');
});
