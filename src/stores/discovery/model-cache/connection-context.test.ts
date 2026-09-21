import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { Config } from '../../../core/schemas/config.js';
import { createProductionDetectionDeps } from '../../../engine/detection/deps.js';
import type { ConfiguredProviderOutcome } from '../../../engine/detection/provider-outcomes.js';
import type { ResolvedDetectionSourceContexts } from '../../../engine/detection/service.js';
import { resolveModelCatalog } from '../../../engine/providers/model/catalog.js';
import { createOllamaProvider } from '../../../engine/providers/ollama.js';
import { probeRunnerAvailability } from '../../../engine/runners/probe-availability.js';
import { modelCacheStore } from './state.js';

const ENV_NAME = 'SPLITBRIEF_TEST_CATALOG_ROTATION';

function config(apiBase = 'http://localhost:1234/v1', apiKey?: string): Config {
  return makeConfig({
    planner: {
      kind: 'api',
      provider: 'lm-studio',
      model: 'plan-model',
      apiBase: 'http://localhost:1236/v1',
    },
    reviewer: {
      kind: 'api',
      provider: 'lm-studio',
      model: 'review-model',
      apiBase,
      ...(apiKey === undefined ? {} : { apiKey }),
    },
  });
}

function contexts(config: Config): ResolvedDetectionSourceContexts {
  return createProductionDetectionDeps({ config, projectDir: '/fixture/catalog' }).sourceContexts;
}

function publishCatalogs(contexts: ResolvedDetectionSourceContexts): void {
  const request = modelCacheStore.beginRefresh({ contexts });
  expect(
    modelCacheStore.publishLane({
      request,
      lane: {
        lane: 'readiness',
        outcome: {
          kind: 'fresh',
          origin: 'request',
          snapshot: {
            source: 'readiness',
            contextKey: contexts.readiness,
            generation: 1,
            requestId: 1,
            fetchedAt: 100,
            validatedAt: 100,
            stale: false,
            value: {
              providers: [],
              cliTools: [],
              configuredProviderOutcomes: (contexts.configuredProviders ?? []).map(
                (connection): ConfiguredProviderOutcome => ({
                  connection,
                  outcome: {
                    kind: 'success',
                    source: 'provider-runtime',
                    provider: connection.provider,
                    isLocal: true,
                    credential: 'present',
                    catalog: 'populated',
                    models: [
                      { id: connection.role === 'planner' ? 'plan-model' : 'old-review-model' },
                    ],
                  },
                }),
              ),
            },
          },
        },
      },
    }),
  ).toBe(true);
}

function modelIds(role: 'planner' | 'reviewer'): string[] {
  return resolveModelCatalog('lm-studio', { cache: modelCacheStore, role }).map(
    (entry) => entry.selectionId,
  );
}

function refuseRefresh(contexts: ResolvedDetectionSourceContexts): void {
  const request = modelCacheStore.beginRefresh({ contexts });
  expect(modelIds('reviewer')).not.toContain('old-review-model');
  expect(modelIds('planner')).toContain('plan-model');
  expect(
    modelCacheStore.publishLane({
      request,
      lane: {
        lane: 'readiness',
        outcome: {
          kind: 'failed',
          source: 'readiness',
          contextKey: contexts.readiness,
          generation: 2,
          requestId: 2,
          checkedAt: 200,
          error: { kind: 'offline', message: 'Fixture failed lane.' },
        },
      },
    }),
  ).toBe(true);
  expect(modelIds('reviewer')).not.toContain('old-review-model');
  expect(modelIds('planner')).toContain('plan-model');
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type ResponseRelease = (response: Response) => void;

function takeResponseRelease(value: ResponseRelease | undefined): ResponseRelease {
  if (value === undefined) throw new Error('fixture release unavailable');
  return value;
}

describe('configured catalog connection lifetime', () => {
  beforeEach(() => modelCacheStore.reset());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    modelCacheStore.reset();
  });

  it('removes a changed endpoint during refresh and failure while preserving the other seat', () => {
    const before = contexts(config());
    publishCatalogs(before);
    expect(modelIds('reviewer')).toContain('old-review-model');
    const after = contexts(config('http://localhost:1235/v1'));
    expect(after.configuredProviders?.find((entry) => entry.role === 'planner')).toEqual(
      before.configuredProviders?.find((entry) => entry.role === 'planner'),
    );
    refuseRefresh(after);
  });

  it('invalidates visible membership and overlapping readiness after an env token rotates', async () => {
    vi.stubEnv(ENV_NAME, 'fixture-token-a');
    const selected = config(undefined, `env:${ENV_NAME}`);
    const before = contexts(selected);
    publishCatalogs(before);
    let releaseFirst: ((response: Response) => void) | undefined;
    let calls = 0;
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      if (new Headers(init?.headers).get('Authorization') === 'Bearer fixture-token-a') {
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return json({ error: 'Fixture credential refused.' }, 401);
    });
    const first = probeRunnerAvailability({ config: selected, roles: ['reviewer'] });
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());
    vi.stubEnv(ENV_NAME, 'fixture-token-b');
    const after = contexts(selected);
    expect(after.readiness).not.toBe(before.readiness);
    expect(JSON.stringify(after)).not.toContain('fixture-token');
    refuseRefresh(after);
    const second = probeRunnerAvailability({ config: selected, roles: ['reviewer'] });
    releaseFirst?.(json({ models: [{ key: 'review-model', type: 'llm' }] }));
    const [oldResult, newResult] = await Promise.all([first, second]);
    expect(oldResult[0]?.verdict.state).toBe('available');
    expect(newResult[0]?.verdict.state).toBe('unauthorized');
    expect(calls).toBe(2);
  });

  it('still shares anonymous local readiness while cancellation and settlement stay caller-owned', async () => {
    const selected = config();
    let release: ((response: Response) => void) | undefined;
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const leaving = new AbortController();
    const first = probeRunnerAvailability({
      config: selected,
      roles: ['reviewer'],
      signal: leaving.signal,
    });
    const second = probeRunnerAvailability({ config: selected, roles: ['reviewer'] });
    await vi.waitFor(() => expect(release).toBeDefined());
    leaving.abort();
    expect((await first)[0]?.verdict.state).toBe('not-probed');
    expect(calls).toBe(1);
    takeResponseRelease(release)(json({ models: [{ key: 'review-model', type: 'llm' }] }));
    expect((await second)[0]?.verdict.state).toBe('available');
    release = undefined;
    const later = probeRunnerAvailability({ config: selected, roles: ['reviewer'] });
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(calls).toBe(2);
    takeResponseRelease(release)(json({ models: [{ key: 'review-model', type: 'llm' }] }));
    expect((await later)[0]?.verdict.state).toBe('available');
  });

  it.each([{}, { context_length: 8192 }, { name: '' }, { model: ' ' }])(
    'keeps loading unknown for an optional ps entry without a usable identity: %j',
    async (entry) => {
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/tags') return json({ models: [{ name: 'fixture-model:8b' }] });
        if (path === '/api/ps') return json({ models: [entry] });
        throw new Error(`Unexpected fixture route: ${path}`);
      });
      const models = await createOllamaProvider().listModelsWithMetadata();
      expect(models).toMatchObject([{ id: 'fixture-model:8b', runtime: { loadState: 'unknown' } }]);
    },
  );

  it('keeps a valid empty ps observation distinct from malformed observations', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request) =>
      json({
        models:
          new URL(String(input)).pathname === '/api/tags' ? [{ name: 'fixture-model:8b' }] : [],
      }),
    );
    expect(await createOllamaProvider().listModelsWithMetadata()).toMatchObject([
      { id: 'fixture-model:8b', runtime: { loadState: 'not-loaded' } },
    ]);
  });
});
