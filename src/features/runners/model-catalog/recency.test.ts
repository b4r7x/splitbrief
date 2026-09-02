import { describe, expect, it } from 'vitest';
import { sortModelsByRecency, type ModelOption, type ModelVariant } from './recency.js';

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

  it('keeps confirmed rows in the tool native order ahead of catalog rows', () => {
    const sorted = sortModelsByRecency([
      { id: 'zeta', nativeOrder: 2 },
      { id: 'alpha', nativeOrder: 0 },
      { id: 'mid', nativeOrder: 1 },
      { id: 'catalog-only' },
    ]);

    expect(sorted.map((model) => model.id)).toEqual(['alpha', 'mid', 'zeta', 'catalog-only']);
  });

  it('keeps stale membership facts intact while ordering rows', () => {
    const stale: ModelOption = {
      id: 'last-confirmed',
      membership: 'stale',
      isStale: true,
      isDetected: false,
    };

    const sorted = sortModelsByRecency([{ id: 'newer-20260101' }, stale]);

    expect(sorted.find((model) => model.id === stale.id)).toEqual(stale);
  });

  it('keeps provider variants intact while ordering rows', () => {
    // The three-field literal pins the cross-package ModelVariant contract.
    const variant: ModelVariant = {
      fullId: 'opencode-go/deepseek-v4-flash',
      providerPrefix: 'opencode-go',
      tag: 'opencode-go',
    };
    const merged: ModelOption = {
      id: 'ollama-cloud/deepseek-v4-flash',
      membership: 'confirmed',
      variants: [
        {
          fullId: 'ollama-cloud/deepseek-v4-flash',
          providerPrefix: 'ollama-cloud',
          tag: 'ollama-cloud',
        },
        variant,
      ],
    };

    const sorted = sortModelsByRecency([{ id: 'newer-20260101' }, merged]);

    expect(sorted.find((model) => model.id === merged.id)).toEqual(merged);
  });
});
