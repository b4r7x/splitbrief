import { describe, expect, it } from 'vitest';
import { mergeCatalogRead } from './catalog-read-merge.js';

describe('mergeCatalogRead', () => {
  const a = { id: 'model-a', displayName: 'A' };
  const b = { id: 'model-b' };
  const c = { id: 'model-c' };

  it('confirms a full cold read', () => {
    expect(
      mergeCatalogRead({ cachedModels: null, missingOnce: undefined, readModels: [a, b] }),
    ).toEqual({
      models: [a, b],
      missingOnce: [],
      complete: true,
    });
  });

  it('adds new models and replaces metadata in read order without mutating the cache', () => {
    const cachedModels = [a, b];
    const updated = { id: 'model-a', displayName: 'Updated A', outputModalities: ['text'] };
    expect(
      mergeCatalogRead({ cachedModels, missingOnce: [], readModels: [c, b, updated] }),
    ).toEqual({
      models: [c, b, updated],
      missingOnce: [],
      complete: true,
    });
    expect(cachedModels).toEqual([a, b]);
  });

  it('keeps missing models after one read, in cached order', () => {
    expect(mergeCatalogRead({ cachedModels: [a, b], missingOnce: [], readModels: [c] })).toEqual({
      models: [c, a, b],
      missingOnce: [a.id, b.id],
      complete: false,
    });
  });

  it('removes a model after the second agreeing read', () => {
    const first = mergeCatalogRead({ cachedModels: [a, b], missingOnce: [], readModels: [a] });
    expect(
      mergeCatalogRead({
        cachedModels: first.models,
        missingOnce: first.missingOnce,
        readModels: [a],
      }),
    ).toEqual({
      models: [a],
      missingOnce: [],
      complete: true,
    });
  });

  it('clears the mark when a missing model returns', () => {
    const returned = mergeCatalogRead({
      cachedModels: [a, b],
      missingOnce: [b.id],
      readModels: [b, a],
    });
    expect(returned).toEqual({ models: [b, a], missingOnce: [], complete: true });
    expect(
      mergeCatalogRead({
        cachedModels: returned.models,
        missingOnce: returned.missingOnce,
        readModels: [a],
      }),
    ).toEqual({
      models: [a, b],
      missingOnce: [b.id],
      complete: false,
    });
  });

  it('keeps every cached model after one empty read', () => {
    expect(mergeCatalogRead({ cachedModels: [a, b], missingOnce: [], readModels: [] })).toEqual({
      models: [a, b],
      missingOnce: [a.id, b.id],
      complete: false,
    });
  });

  it('removes every model after two empty reads but never confirms an empty read', () => {
    const first = mergeCatalogRead({ cachedModels: [a, b], missingOnce: [], readModels: [] });
    expect(
      mergeCatalogRead({
        cachedModels: first.models,
        missingOnce: first.missingOnce,
        readModels: [],
      }),
    ).toEqual({
      models: [],
      missingOnce: [],
      complete: false,
    });
    expect(
      mergeCatalogRead({ cachedModels: undefined, missingOnce: undefined, readModels: [] }),
    ).toEqual({
      models: [],
      missingOnce: [],
      complete: false,
    });
  });
});
