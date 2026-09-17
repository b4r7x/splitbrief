import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveApiRuntimeStatus,
  type ApiRuntimeObservation,
  type ApiRuntimeSignal,
} from './api-runtime-status.js';
import { apiConnectionContextKey } from './selected-model.js';
import { createClientFromProvider } from './client/connection.js';
import { getProvider } from './registry.js';
import { toStreamClient } from './openai-stream/client.js';
import { dispatchStreamCompletion } from './dispatch-stream.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { projectRunnerCallEvents } from '../calls/event-projection.js';
import { updateOperations } from '../../stores/workflow/operations/reducer.js';
import type { OperationsState } from '../../stores/workflow/operations/state.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

const CONTEXT_KEY = apiConnectionContextKey('lm-studio', 'http://127.0.0.1:1234/v1');
const SELECTION_ID = 'qwen3-coder-30b@q4_k_m';
const IDENTITY = { contextKey: CONTEXT_KEY, selectionId: SELECTION_ID } as const;

function observed(
  loadState: ApiRuntimeObservation['loadState'],
  overrides: Partial<ApiRuntimeObservation> = {},
): ApiRuntimeObservation {
  return {
    contextKey: CONTEXT_KEY,
    selectionId: SELECTION_ID,
    observedAt: 1_700_000_000_000,
    loadState,
    ...overrides,
  };
}

function status(observation: ApiRuntimeObservation | undefined, ...signals: ApiRuntimeSignal[]) {
  return deriveApiRuntimeStatus({
    identity: IDENTITY,
    ...(observation !== undefined && { observation }),
    signals,
  });
}

describe('deriveApiRuntimeStatus', () => {
  it.each(['lm-studio', 'llama-cpp', 'ollama'])(
    'binds the default %s observation to its resolved dispatch endpoint',
    (provider) => {
      const resolved = getProvider(provider);
      expect(apiConnectionContextKey(provider, undefined)).toBe(
        apiConnectionContextKey(provider, resolved.baseURL),
      );
      expect(apiConnectionContextKey(provider, `${resolved.baseURL}/`)).toBe(
        apiConnectionContextKey(provider, resolved.baseURL),
      );
    },
  );

  it('keeps a dispatched call on a not-loaded model waiting, and never calls it loading', () => {
    expect(status(observed('not-loaded'), 'dispatched')).toEqual({
      phase: 'waiting-first-response',
      loadState: 'not-loaded',
      observedAt: 1_700_000_000_000,
    });
  });

  it('repeats an unknown load state rather than reading the dispatch as one', () => {
    expect(status(observed('unknown'), 'dispatched')).toEqual({
      phase: 'waiting-first-response',
      loadState: 'unknown',
      observedAt: 1_700_000_000_000,
    });
  });

  it('stays neutral with no observation at all, and dates nothing', () => {
    const neutral = status(undefined, 'dispatched');
    expect(neutral).toEqual({ phase: 'waiting-first-response', loadState: 'unknown' });
    expect(neutral).not.toHaveProperty('observedAt');
  });

  it('turns to streaming on the first chunk, keeping the observed load state', () => {
    expect(status(observed('loaded'), 'dispatched', 'chunk')).toEqual({
      phase: 'streaming',
      loadState: 'loaded',
      observedAt: 1_700_000_000_000,
    });
  });

  it('publishes nothing until something is actually dispatched', () => {
    expect(status(observed('loaded'))).toBeNull();
    expect(status(observed('not-loaded'))).toBeNull();
  });

  describe('a stale context identity cannot publish', () => {
    it('refuses an observation taken on another connection', () => {
      const elsewhere = observed('loaded', {
        contextKey: apiConnectionContextKey('lm-studio', 'http://127.0.0.1:9999/v1'),
      });
      expect(status(elsewhere, 'dispatched')).toBeNull();
      expect(status(elsewhere, 'dispatched', 'chunk')).toBeNull();
    });

    it('refuses an observation of another selection on the same connection', () => {
      expect(status(observed('loaded', { selectionId: 'gpt-oss-20b' }), 'dispatched')).toBeNull();
    });
  });

  describe('abort freezes updates', () => {
    it('stays finished when a chunk arrives after the call settled', () => {
      const frozen = status(observed('loaded'), 'dispatched', 'settled', 'chunk', 'chunk');
      expect(frozen).toEqual({
        phase: 'finished',
        loadState: 'loaded',
        observedAt: 1_700_000_000_000,
      });
      expect(frozen).toEqual(status(observed('loaded'), 'dispatched', 'settled'));
    });

    it('finishes a stream that had already started', () => {
      expect(status(observed('loaded'), 'dispatched', 'chunk', 'settled')).toEqual({
        phase: 'finished',
        loadState: 'loaded',
        observedAt: 1_700_000_000_000,
      });
    });

    it('never reports the server unloaded because the application stopped waiting', () => {
      const cancelled = status(observed('loaded'), 'dispatched', 'settled');
      expect(cancelled?.loadState).toBe('loaded');
      expect(cancelled?.observedAt).toBe(1_700_000_000_000);
    });
  });
});

describe('runtime status through the installed SDK and operations', () => {
  setupFetchMock();
  afterEach(() => vi.unstubAllEnvs());

  it.each(['not-loaded', 'unknown'] as const)(
    'publishes only phase transitions and preserves an observed %s load state',
    async (loadState) => {
      vi.stubEnv('LM_STUDIO_API_KEY', '');
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(stream.readable, { headers: { 'content-type': 'text/event-stream' } }),
      );
      const provider = getProvider('lm-studio', { apiBase: 'http://127.0.0.1:1234/v1' });
      const events: RunnerCallEvent[] = [];
      let operations: OperationsState = { active: null, last: null, byCallId: new Map() };
      const firstText = Promise.withResolvers<void>();
      const runtimeObservation = { ...observed(loadState) };
      const call = dispatchStreamCompletion({
        provider: provider.name,
        client: toStreamClient(createClientFromProvider(provider)),
        apiKey: provider.apiKey(),
        apiBase: provider.baseURL,
        model: SELECTION_ID,
        messages: [{ role: 'user', content: 'fixture request' }],
        temperature: 0,
        runtimeObservation,
        onProgress: () => firstText.resolve(),
        onCallEvent: (event) => {
          events.push(event);
          for (const projected of projectRunnerCallEvents(event, {
            phase: 'planning',
            sequence: events.length,
          })) {
            operations = updateOperations(operations, projected);
          }
        },
      });
      expect(operations.active?.apiRuntimeStatus).toEqual({
        phase: 'waiting-first-response',
        loadState,
        observedAt: 1_700_000_000_000,
      });
      runtimeObservation.loadState = 'loaded';
      const encode = (content: string, finish: string | null = null) =>
        new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`,
        );
      await writer.write(encode('first'));
      await firstText.promise;
      expect(operations.active?.apiRuntimeStatus?.phase).toBe('streaming');
      await writer.write(encode(' second', 'stop'));
      await writer.write(new TextEncoder().encode('data: [DONE]\n\n'));
      await writer.close();
      expect((await call).text).toBe('first second');
      expect(operations.last?.apiRuntimeStatus).toEqual({
        phase: 'finished',
        loadState,
        observedAt: 1_700_000_000_000,
      });
      const statuses = events.filter((event) => event.type === 'call_runtime_status');
      expect(statuses.map((event) => event.runtimeStatus.phase)).toEqual([
        'waiting-first-response',
        'streaming',
        'finished',
      ]);
      expect(JSON.stringify(statuses)).not.toContain(CONTEXT_KEY);
      expect(events.at(-1)?.type).toBe('call_completed');
    },
  );

  it('aborts the installed SDK HTTP request and finishes application waiting', async () => {
    vi.stubEnv('LM_STUDIO_API_KEY', '');
    const requested = Promise.withResolvers<AbortSignal>();
    vi.mocked(globalThis.fetch).mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error('Expected the SDK request to carry a signal');
          requested.resolve(signal);
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('fixture aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const provider = getProvider('lm-studio');
    const controller = new AbortController();
    const events: RunnerCallEvent[] = [];
    const call = dispatchStreamCompletion({
      provider: provider.name,
      client: toStreamClient(createClientFromProvider(provider)),
      apiKey: provider.apiKey(),
      apiBase: provider.baseURL,
      model: SELECTION_ID,
      messages: [],
      temperature: 0,
      onProgress: () => {},
      signal: controller.signal,
      onCallEvent: (event) => events.push(event),
    });
    const rejected = expect(call).rejects.toThrow('This operation was aborted');
    const requestSignal = await requested.promise;
    controller.abort();
    await rejected;
    expect(requestSignal.aborted).toBe(true);
    expect(
      events
        .filter((event) => event.type === 'call_runtime_status')
        .map((event) => event.runtimeStatus.phase),
    ).toEqual(['waiting-first-response', 'finished']);
    expect(events.at(-1)).toMatchObject({ type: 'call_error', status: 'aborted' });
  });

  it.each([undefined, observed('loaded', { selectionId: 'other-model' })])(
    'keeps missing metadata unknown and suppresses mismatched metadata at real dispatch',
    async (runtimeObservation) => {
      vi.stubEnv('LM_STUDIO_API_KEY', '');
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
      const provider = getProvider('lm-studio');
      const events: RunnerCallEvent[] = [];
      await dispatchStreamCompletion({
        provider: provider.name,
        client: toStreamClient(createClientFromProvider(provider)),
        apiKey: provider.apiKey(),
        apiBase: provider.baseURL,
        model: SELECTION_ID,
        messages: [{ role: 'user', content: 'fixture' }],
        temperature: 0,
        onProgress: () => {},
        runtimeObservation,
        onCallEvent: (event) => events.push(event),
      });
      const statuses = events.filter((event) => event.type === 'call_runtime_status');
      expect(statuses.map((event) => event.runtimeStatus)).toEqual(
        runtimeObservation === undefined
          ? [
              { phase: 'waiting-first-response', loadState: 'unknown' },
              { phase: 'streaming', loadState: 'unknown' },
              { phase: 'finished', loadState: 'unknown' },
            ]
          : [],
      );
    },
  );
});
