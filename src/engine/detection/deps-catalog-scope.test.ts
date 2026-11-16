import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { Config } from '../../core/schemas/config.js';
import type { PlannerConfig } from '../../core/schemas/runner/planner.js';
import type { ConfiguredProviderOutcome } from './provider-outcomes.js';
import { createProductionDetectionDeps } from './deps.js';

/** A local API seat every role can hold; `model` is exact, never inferred. */
type LocalApiSeat = Extract<PlannerConfig, { kind: 'api' }> & { readonly model: string };

function localSeat(port: number, model: string, apiKey?: string): LocalApiSeat {
  return {
    kind: 'api',
    provider: 'ollama',
    service: 'ollama',
    offering: 'local',
    model,
    apiBase: `http://127.0.0.1:${port}/v1`,
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

/**
 * Ollama and LM Studio are still admitted for the implementer role only, so a
 * planner-tier local seat cannot be expressed through `ConfigSchema` yet. The
 * seats are attached to a parsed config directly: this card owns the discovery
 * scope of a configured seat, not its role admission.
 */
function configWithSeats(
  seats: Readonly<{ planner: LocalApiSeat; implementer?: LocalApiSeat; reviewer?: LocalApiSeat }>,
): Config {
  const base = makeConfig({ implementer: { kind: 'cli', tool: 'claude-code' } });
  return {
    ...base,
    planner: seats.planner,
    ...(seats.implementer === undefined ? {} : { implementer: seats.implementer }),
    ...(seats.reviewer === undefined ? {} : { reviewer: seats.reviewer }),
  };
}

function tagsUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/tags`;
}

function routeTagsByPort(catalogs: Readonly<Record<number, readonly string[]>>): string[] {
  const requested: string[] = [];
  vi.mocked(globalThis.fetch).mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    requested.push(url);
    const models = catalogs[Number(new URL(url).port)];
    if (models === undefined || !url.endsWith('/api/tags'))
      return new Response('', { status: 404 });
    return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }), {
      status: 200,
    });
  });
  return requested;
}

describe('configured provider catalog scope', () => {
  setupFetchMock();

  let emptyPathDir: string;
  let projectDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    emptyPathDir = createTempDir('seat-scope-path');
    projectDir = createTempDir('seat-scope-project');
    savedPath = process.env.PATH;
    process.env.PATH = emptyPathDir;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    cleanupTempDir(emptyPathDir);
    cleanupTempDir(projectDir);
  });

  const outcomeFor = (
    outcomes: readonly ConfiguredProviderOutcome[],
    role: string,
  ): ConfiguredProviderOutcome | undefined =>
    outcomes.find((entry) => entry.connection.role === role);

  it('probes each configured seat on its own endpoint and attributes every outcome to that seat', async () => {
    const requested = routeTagsByPort({
      11434: ['plan-model:8b'],
      11435: ['build-model:8b'],
      11436: ['review-model:8b'],
    });
    const deps = createProductionDetectionDeps({
      config: configWithSeats({
        planner: localSeat(11434, 'plan-model:8b'),
        implementer: localSeat(11435, 'build-model:8b'),
        reviewer: localSeat(11436, 'review-model:8b'),
      }),
      projectDir,
    });

    const outcomes = (await deps.detectAll({ signal: new AbortController().signal }))
      .configuredProviderOutcomes;
    if (outcomes === undefined) throw new Error('Expected configured provider outcomes.');

    expect(outcomes.map((entry) => entry.connection.role).toSorted()).toEqual([
      'implementer',
      'planner',
      'reviewer',
    ]);
    expect(new Set(outcomes.map((entry) => entry.connection.contextKey)).size).toBe(3);
    expect(outcomeFor(outcomes, 'planner')?.outcome).toMatchObject({
      kind: 'success',
      models: [{ id: 'plan-model:8b' }],
    });
    expect(outcomeFor(outcomes, 'implementer')?.outcome).toMatchObject({
      kind: 'success',
      models: [{ id: 'build-model:8b' }],
    });
    expect(outcomeFor(outcomes, 'reviewer')?.outcome).toMatchObject({
      kind: 'success',
      models: [{ id: 'review-model:8b' }],
    });
    expect(requested.filter((url) => url.endsWith('/api/tags')).toSorted()).toEqual(
      [tagsUrl(11434), tagsUrl(11435), tagsUrl(11436)].toSorted(),
    );
  });

  it('reuses the planner request for an absent reviewer and still publishes an exact reviewer outcome', async () => {
    const requested = routeTagsByPort({ 11434: ['plan-model:8b'] });
    const deps = createProductionDetectionDeps({
      config: configWithSeats({ planner: localSeat(11434, 'plan-model:8b') }),
      projectDir,
    });

    const outcomes = (await deps.detectAll({ signal: new AbortController().signal }))
      .configuredProviderOutcomes;
    if (outcomes === undefined) throw new Error('Expected configured provider outcomes.');

    expect(outcomes.map((entry) => entry.connection.role).toSorted()).toEqual([
      'planner',
      'reviewer',
    ]);
    expect(requested.filter((url) => url === tagsUrl(11434))).toHaveLength(1);

    const planner = outcomeFor(outcomes, 'planner');
    const reviewer = outcomeFor(outcomes, 'reviewer');
    expect(reviewer?.outcome).toEqual(planner?.outcome);
    expect(reviewer?.outcome).not.toBe(planner?.outcome);
    expect(reviewer?.connection.contextKey).not.toBe(planner?.connection.contextKey);
  });

  it('keeps a rejected reviewer credential unpublished and off the planner catalog', async () => {
    routeTagsByPort({ 11434: ['plan-model:8b'], 11436: ['review-model:8b'] });
    const credential = 'reviewer-inline-credential-canary';
    const deps = createProductionDetectionDeps({
      config: configWithSeats({
        planner: localSeat(11434, 'plan-model:8b'),
        reviewer: localSeat(11436, 'review-model:8b', credential),
      }),
      projectDir,
    });

    const outcomes = (await deps.detectAll({ signal: new AbortController().signal }))
      .configuredProviderOutcomes;
    if (outcomes === undefined) throw new Error('Expected configured provider outcomes.');

    const published = JSON.stringify({ outcomes, sourceContexts: deps.sourceContexts });
    expect(published).not.toContain(credential);
    // Ollama admits no inline credential, so the reviewer probe fails on its own
    // connection: it never inherits the planner's catalog.
    expect(outcomeFor(outcomes, 'reviewer')?.outcome.kind).toBe('failed');
    expect(outcomeFor(outcomes, 'planner')?.outcome).toMatchObject({
      kind: 'success',
      models: [{ id: 'plan-model:8b' }],
    });
  });

  it('changes every discovery source context when the reviewer connection changes', () => {
    const planner = localSeat(11434, 'plan-model:8b');
    const sourceContextsFor = (reviewer: LocalApiSeat) =>
      createProductionDetectionDeps({
        config: configWithSeats({ planner, reviewer }),
        projectDir,
      }).sourceContexts;

    const first = sourceContextsFor(localSeat(11436, 'review-model:8b'));
    const movedEndpoint = sourceContextsFor(localSeat(11437, 'review-model:8b'));
    const addedCredential = sourceContextsFor(
      localSeat(11436, 'review-model:8b', 'env:REVIEWER_API_KEY'),
    );

    for (const source of ['readiness', 'modelsDev', 'cliModels'] as const) {
      expect(new Set([first[source], movedEndpoint[source], addedCredential[source]]).size).toBe(3);
    }
    expect(new Set(Object.values(first)).size).toBe(4);
  });
});
