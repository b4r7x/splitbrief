import { describe, expect, it } from 'vitest';
import { sortModelsByRecency } from './recency.js';

describe('model recency ordering', () => {
  it('sorts models by default flag, release date, embedded dates, and name', () => {
    const input = [
      { id: 'new-model-20250101', releaseDate: '2025-01-01' },
      { id: 'release-old', releaseDate: '2024-01-01' },
      { id: 'release-new', releaseDate: '2025-01-01' },
      { id: 'old-default', isDefault: true },
      { id: 'model-20240101' },
      { id: 'model-20250101' },
      { id: 'gpt-4' },
      { id: 'gpt-5' },
      { id: 'gemini-2.0-pro' },
      { id: 'gemini-2.5-pro' },
    ];

    expect(sortModelsByRecency(input).map((model) => model.id)).toEqual([
      'old-default',
      'new-model-20250101',
      'release-new',
      'release-old',
      'model-20250101',
      'model-20240101',
      'gpt-5',
      'gpt-4',
      'gemini-2.5-pro',
      'gemini-2.0-pro',
    ]);
    expect(input.map((model) => model.id)).toEqual([
      'new-model-20250101',
      'release-old',
      'release-new',
      'old-default',
      'model-20240101',
      'model-20250101',
      'gpt-4',
      'gpt-5',
      'gemini-2.0-pro',
      'gemini-2.5-pro',
    ]);
  });
});
