import { describe, expect, it } from 'vitest';
import { ModelsDevCatalogSchema } from './models-dev.js';

describe('ModelsDevCatalogSchema', () => {
  it('preserves provider ownership and picker-relevant model metadata', () => {
    const catalog = ModelsDevCatalogSchema.parse({
      'provider-a': {
        id: 'provider-a',
        name: 'Provider A',
        models: {
          'model-x': {
            id: 'model-x',
            name: 'Model X',
            status: 'deprecated',
            release_date: '2025-02-01',
            last_updated: '2026-01-15',
            limit: {
              context: 200_000,
              input: 180_000,
              output: 32_768,
            },
            modalities: {
              input: ['text', 'image'],
              output: ['text'],
            },
            tool_call: true,
            structured_output: true,
          },
        },
      },
    });

    expect(catalog['provider-a']).toEqual({
      id: 'provider-a',
      name: 'Provider A',
      models: {
        'model-x': {
          id: 'model-x',
          name: 'Model X',
          status: 'deprecated',
          release_date: '2025-02-01',
          last_updated: '2026-01-15',
          limit: {
            context: 200_000,
            input: 180_000,
            output: 32_768,
          },
          modalities: {
            input: ['text', 'image'],
            output: ['text'],
          },
          tool_call: true,
          structured_output: true,
        },
      },
    });
  });

  it('rejects a remote model without its exact upstream ID', () => {
    expect(
      ModelsDevCatalogSchema.safeParse({
        'provider-a': {
          id: 'provider-a',
          models: {
            unknown: { name: 'Unknown model' },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('keeps additional public metadata while validating picker-relevant fields', () => {
    const catalog = ModelsDevCatalogSchema.parse({
      'provider-a': {
        id: 'provider-a',
        name: 'Provider A',
        api: 'https://catalog.provider-a.example/v1',
        models: {
          'model-x': {
            id: 'model-x',
            name: 'Model X',
            release_date: '2025-02-01',
            last_updated: '2026-01-15',
            status: 'deprecated',
            limit: { context: 200_000, output: 32_768 },
            modalities: { input: ['text', 'image'], output: ['text'] },
            tool_call: true,
            structured_output: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
          },
        },
      },
    });

    expect(catalog['provider-a']?.api).toBe('https://catalog.provider-a.example/v1');
    expect(catalog['provider-a']?.models['model-x']).toMatchObject({
      name: 'Model X',
      release_date: '2025-02-01',
      last_updated: '2026-01-15',
      status: 'deprecated',
      limit: { context: 200_000, output: 32_768 },
      modalities: { input: ['text', 'image'], output: ['text'] },
      tool_call: true,
      structured_output: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
    });
  });

  it('drops a non-string rung instead of rejecting the catalog', () => {
    const catalog = ModelsDevCatalogSchema.parse({
      sarvam: {
        id: 'sarvam',
        models: {
          'sarvam-105b': {
            id: 'sarvam-105b',
            reasoning_options: [{ type: 'effort', values: [null, 'low', 'medium', 'high'] }],
          },
        },
      },
    });

    expect(catalog['sarvam']?.models['sarvam-105b']?.reasoning_options).toEqual([
      { type: 'effort', values: ['low', 'medium', 'high'] },
    ]);
  });
});
