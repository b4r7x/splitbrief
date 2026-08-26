import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { realPickerOption } from '#testing/helpers/runner-picker.js';
import { commitImplementerSelection, commitPlannerTierSelection } from './config-transforms.js';

const KEY = 'sk-test-commit-key-1234';

describe('runner selection commits with an inline apiKey', () => {
  it('stores the key and selects the provider in one planner config', () => {
    const { config: updated } = commitPlannerTierSelection({
      config: makeConfig(),
      role: 'planner',
      selection: realPickerOption('planner', 'openai'),
      model: { id: 'gpt-5-mini' },
      apiKey: KEY,
    });

    expect(updated.planner).toMatchObject({
      kind: 'api',
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: KEY,
    });
  });

  it('stores the key and selects the provider in one implementer config', () => {
    const { config: updated } = commitImplementerSelection(
      makeConfig(),
      realPickerOption('implementer', 'groq'),
      { id: 'llama-3.3-70b-versatile' },
      KEY,
    );

    expect(updated.implementer).toMatchObject({
      kind: 'api',
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      apiKey: KEY,
    });
  });

  it('keeps the stored key when the same provider is re-selected without one', () => {
    const config = makeConfig({
      planner: {
        kind: 'api',
        provider: 'openai',
        apiBase: 'https://api.openai.com/v1',
        model: 'gpt-5-mini',
        apiKey: KEY,
      },
    });

    const { config: updated } = commitPlannerTierSelection({
      config,
      role: 'planner',
      selection: realPickerOption('planner', 'openai'),
      model: { id: 'gpt-5-mini' },
    });

    expect(updated.planner).toMatchObject({ kind: 'api', provider: 'openai', apiKey: KEY });
  });
});
