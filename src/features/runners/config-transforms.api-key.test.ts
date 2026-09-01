import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { realPickerOption } from '#testing/helpers/runner-picker.js';
import { commitImplementerSelection } from './config-transforms.js';

const KEY = 'sk-test-commit-key-1234';

describe('runner selection commits against a stored apiKey', () => {
  it('keeps the stored key when the same provider is re-selected', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'lm-studio',
        apiBase: 'http://localhost:1234/v1',
        model: 'qwen2.5-coder-7b',
        apiKey: KEY,
      },
    });

    const { config: updated } = commitImplementerSelection({
      config,
      selection: realPickerOption('implementer', 'lm-studio'),
      model: { id: 'qwen2.5-coder-7b' },
    });

    expect(updated.implementer).toMatchObject({
      kind: 'api',
      provider: 'lm-studio',
      apiKey: KEY,
    });
  });
});
