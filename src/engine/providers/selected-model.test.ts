import { describe, it, expect, beforeEach, vi } from 'vitest';
import { probeSelectedProviderModel } from './selected-model.js';
import * as catalogDetection from './catalog-detection.js';
import { PROVIDER_CATALOG_FAILURE_KINDS } from './types.js';
import type { ProviderCatalogOutcome } from './types.js';
import { error } from '../../utils/error.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

vi.mock('./catalog-detection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof catalogDetection>();
  return { ...actual, detectProviderCatalog: vi.fn(actual.detectProviderCatalog) };
});

const detectProviderCatalog = vi.mocked(catalogDetection.detectProviderCatalog);

function ollamaTags(models: readonly unknown[]): Response {
  return new Response(JSON.stringify({ models }), { status: 200 });
}

/** A listing is one `/api/tags` read followed by one read-only `/api/ps` observation. */
function mockOllamaListing(models: readonly unknown[], loaded: readonly unknown[] = []): void {
  vi.mocked(globalThis.fetch)
    .mockResolvedValueOnce(ollamaTags(models))
    .mockResolvedValueOnce(new Response(JSON.stringify({ models: loaded }), { status: 200 }));
}

const NOT_LOADED = { loadState: 'not-loaded', observedAt: expect.any(Number) };

function probeOllama(selectionId: string) {
  return probeSelectedProviderModel({
    provider: 'ollama',
    overrides: undefined,
    contextKey: 'plan@http://127.0.0.1:11434',
    selectionId,
  });
}

function requestedUrls(): string[] {
  return vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url));
}

describe('probeSelectedProviderModel', () => {
  setupFetchMock();
  beforeEach(() => {
    detectProviderCatalog.mockClear();
  });

  it('binds the exact selected model with its reported metadata', async () => {
    mockOllamaListing([
      { name: 'qwen3-coder:30b', details: { family: 'qwen3' } },
      {
        name: 'qwen3-coder:30b-q4_K_M',
        details: { family: 'qwen3', quantization_level: 'Q4_K_M' },
      },
    ]);

    const probe = await probeOllama('qwen3-coder:30b-q4_K_M');

    expect(probe).toEqual({
      kind: 'found',
      contextKey: 'plan@http://127.0.0.1:11434',
      selectionId: 'qwen3-coder:30b-q4_K_M',
      model: {
        id: 'qwen3-coder:30b-q4_K_M',
        providerId: 'ollama',
        capabilities: ['family:qwen3', 'quantization:Q4_K_M'],
        runtime: NOT_LOADED,
      },
      observedAt: expect.any(Number),
    });
    expect(detectProviderCatalog).toHaveBeenCalledTimes(1);
    expect(detectProviderCatalog).toHaveBeenCalledWith({
      provider: 'ollama',
      configOverrides: undefined,
      signal: undefined,
    });
  });

  it('leaves unreported metadata absent instead of filling it in', async () => {
    mockOllamaListing([{ name: 'llama3:8b' }]);

    const probe = await probeOllama('llama3:8b');

    expect(probe).toMatchObject({ kind: 'found', model: { id: 'llama3:8b' } });
    if (probe.kind !== 'found') throw new Error('expected a found probe');
    expect(probe.model.maximumContextTokens).toBeUndefined();
    expect(probe.model.effectiveContextTokens).toBeUndefined();
    expect(probe.model.supportsToolCalls).toBeUndefined();
    // The observed load state is exactly what /api/ps reported: no instances, no contexts.
    expect(probe.model.runtime).toEqual(NOT_LOADED);
  });

  it.each([
    ['a differently tagged model', 'qwen3-coder:30b-q4_K_M', 'qwen3-coder:30b'],
    ['another sole model', 'llama3:8b', 'qwen3-coder:30b'],
  ])('reports missing-model rather than falling back to %s', async (_label, served, selected) => {
    mockOllamaListing([{ name: served }]);

    expect(await probeOllama(selected)).toEqual({
      kind: 'failed',
      contextKey: 'plan@http://127.0.0.1:11434',
      selectionId: selected,
      failure: 'missing-model',
      diagnostic: `Provider catalog has no model with id "${selected}".`,
    });
  });

  it('keeps an empty catalog distinct from a missing selection', async () => {
    mockOllamaListing([]);

    expect(await probeOllama('qwen3-coder:30b')).toMatchObject({
      kind: 'failed',
      failure: 'empty-catalog',
      diagnostic: 'Provider catalog is empty.',
    });
  });

  it.each(PROVIDER_CATALOG_FAILURE_KINDS)('preserves a native %s failure', async (failure) => {
    detectProviderCatalog.mockResolvedValueOnce({
      kind: 'failed',
      source: 'provider-runtime',
      provider: 'ollama',
      isLocal: true,
      credential: 'not-required',
      failure,
      diagnostic: 'diagnostic under test',
    } satisfies ProviderCatalogOutcome);

    expect(await probeOllama('qwen3-coder:30b')).toEqual({
      kind: 'failed',
      contextKey: 'plan@http://127.0.0.1:11434',
      selectionId: 'qwen3-coder:30b',
      failure,
      diagnostic: 'diagnostic under test',
    });
  });

  it('classifies an unreachable endpoint as offline through the real catalog call', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('Connection refused'));

    expect(await probeOllama('qwen3-coder:30b')).toMatchObject({
      kind: 'failed',
      failure: 'offline',
      diagnostic: 'Connection refused',
    });
  });

  it('classifies a rejected credential through the real catalog call', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 401 }));

    expect(
      await probeSelectedProviderModel({
        provider: 'lm-studio',
        overrides: { apiKey: 'sk-selected-model-rejected' },
        contextKey: 'review@http://127.0.0.1:1234',
        selectionId: 'deepseek-coder-v2',
      }),
    ).toMatchObject({ kind: 'failed', failure: 'invalid-credential' });
  });

  it('stops waiting when the caller aborts', async () => {
    const controller = new AbortController();
    detectProviderCatalog.mockImplementationOnce(
      (options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(error('operation-aborted', 'Operation aborted')),
          );
        }),
    );

    const pending = probeSelectedProviderModel({
      provider: 'ollama',
      overrides: undefined,
      contextKey: 'plan@http://127.0.0.1:11434',
      selectionId: 'qwen3-coder:30b',
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow('Operation aborted');
  });

  it('rejects an already aborted probe without calling the catalog', async () => {
    await expect(
      probeSelectedProviderModel({
        provider: 'ollama',
        overrides: undefined,
        contextKey: 'plan@http://127.0.0.1:11434',
        selectionId: 'qwen3-coder:30b',
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(detectProviderCatalog).not.toHaveBeenCalled();
  });

  it('reads the listing only, with no inference or load route', async () => {
    mockOllamaListing([{ name: 'qwen3-coder:30b' }]);

    await probeOllama('qwen3-coder:30b');

    // The exact sequence: the tag inventory plus the listing's own read-only /api/ps observation.
    expect(requestedUrls()).toEqual([
      'http://localhost:11434/api/tags',
      'http://localhost:11434/api/ps',
    ]);
    for (const url of requestedUrls()) {
      expect(url).not.toMatch(/generate|chat|completions|embed|pull|load|unload|show/);
    }
  });
});
