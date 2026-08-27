import { describe, expect, it } from 'vitest';
import {
  createDetectionCoordinator,
  detectionContextKey,
  detectionSourceContextKey,
  type DetectionProjection,
  type DetectionSourceError,
  type CliModelSnapshot,
} from './coordinator.js';

function createClock() {
  let current = 1_700_000_000_000;
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

function deferred<Value>() {
  const promise = Promise.withResolvers<Value>();
  return { promise: promise.promise, resolve: promise.resolve, reject: promise.reject };
}

function readiness(value: string): DetectionProjection {
  return {
    providers:
      value.length === 0
        ? []
        : [
            {
              provider: 'ollama',
              available: true,
              isLocal: true,
              ...(value === 'first' ? {} : { error: value }),
            },
          ],
    cliTools: [],
  };
}

function failedSource(): DetectionSourceError {
  return { kind: 'request-failed', message: 'Discovery source could not refresh.' };
}

describe('detection coordinator', () => {
  it('scopes source contexts per source and encodes the opaque credential domain', () => {
    const context = detectionContextKey({
      platform: 'darwin',
      runner: 'openai',
      executableFingerprint: 'stat-fingerprint',
      executableVersion: '1.2.3',
      authChannel: 'api-key',
      endpointOrigin: 'https://api.openai.example',
      credentialDomain: 'opaque-config-node-4',
      configGeneration: 'config-9',
    });

    const readinessScope = detectionSourceContextKey({ source: 'readiness', contextKey: context });
    const modelsScope = detectionSourceContextKey({ source: 'models-dev', contextKey: context });

    expect(readinessScope).not.toBe(modelsScope);
    expect(readinessScope).toContain(encodeURIComponent('opaque-config-node-4'));
  });

  it('coalesces identical readers, uses a soft TTL, and lets manual refresh replace a valid empty snapshot', async () => {
    const clock = createClock();
    const coordinator = createDetectionCoordinator({ now: clock.now });
    const initial = deferred<DetectionProjection>();
    const replacement = deferred<DetectionProjection>();
    const started: string[] = [];
    const contextKey = 'runner|endpoint-a|channel-a|generation-a';

    const first = coordinator.refresh({
      source: 'readiness',
      contextKey,
      ttlMs: 1_000,
      mode: 'automatic',
      load: () => {
        started.push('initial');
        return initial.promise;
      },
      error: failedSource,
    });
    const second = coordinator.refresh({
      source: 'readiness',
      contextKey,
      ttlMs: 1_000,
      mode: 'manual',
      load: () => {
        started.push('second-reader');
        return initial.promise;
      },
      error: failedSource,
    });

    expect(started).toEqual(['initial']);
    initial.resolve(readiness('first'));
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ kind: 'fresh', origin: 'request' });
    expect(secondResult).toMatchObject({ kind: 'fresh', origin: 'request' });
    if (firstResult.kind !== 'fresh' || secondResult.kind !== 'fresh') {
      throw new Error('Expected the coalesced readers to receive a fresh snapshot.');
    }
    expect(firstResult.snapshot.requestId).toBe(secondResult.snapshot.requestId);

    clock.advance(100);
    const cached = await coordinator.refresh({
      source: 'readiness',
      contextKey,
      ttlMs: 1_000,
      mode: 'automatic',
      load: () => {
        started.push('ttl-bypass');
        return Promise.resolve(readiness('unexpected'));
      },
      error: failedSource,
    });
    expect(cached).toMatchObject({ kind: 'fresh', origin: 'snapshot' });
    expect(started).toEqual(['initial']);

    const manual = coordinator.refresh({
      source: 'readiness',
      contextKey,
      ttlMs: 1_000,
      mode: 'manual',
      load: () => {
        started.push('manual');
        return replacement.promise;
      },
      error: failedSource,
    });
    const beforeReplacement = coordinator.snapshot({ source: 'readiness', contextKey });
    expect(beforeReplacement?.value).toEqual(readiness('first'));

    replacement.resolve({ providers: [], cliTools: [] });
    const manualResult = await manual;
    expect(manualResult).toMatchObject({ kind: 'fresh', origin: 'request' });
    if (manualResult.kind !== 'fresh') throw new Error('Expected a fresh manual replacement.');
    expect(manualResult.snapshot.value).toEqual({ providers: [], cliTools: [] });
    expect(started).toEqual(['initial', 'manual']);
  });

  it('preserves last success as stale after failure and avoids remote work while offline', async () => {
    const clock = createClock();
    const coordinator = createDetectionCoordinator({ now: clock.now });
    const contextKey = 'runner|endpoint-a|channel-a|generation-a';
    const sourceInvocations: string[] = [];

    await coordinator.refresh({
      source: 'readiness',
      contextKey,
      ttlMs: 1_000,
      mode: 'automatic',
      load: () => {
        sourceInvocations.push('success');
        return Promise.resolve(readiness('last-good'));
      },
      error: failedSource,
    });

    const stale = await coordinator.refresh({
      source: 'readiness',
      contextKey,
      ttlMs: 1_000,
      mode: 'manual',
      load: () => {
        sourceInvocations.push('failure');
        return Promise.reject(new Error('raw endpoint failure must not escape'));
      },
      error: failedSource,
    });
    expect(stale).toMatchObject({
      kind: 'stale',
      snapshot: {
        stale: true,
        value: readiness('last-good'),
        error: { kind: 'request-failed', message: 'Discovery source could not refresh.' },
      },
    });
    expect(JSON.stringify(stale)).not.toContain('raw endpoint failure must not escape');

    const offline = await coordinator.refresh({
      source: 'readiness',
      contextKey,
      ttlMs: 1_000,
      mode: 'manual',
      offline: true,
      load: () => {
        sourceInvocations.push('offline');
        return Promise.resolve(readiness('must-not-run'));
      },
      error: failedSource,
    });
    expect(offline).toMatchObject({
      kind: 'stale',
      snapshot: { stale: true, error: { kind: 'offline' } },
    });
    expect(sourceInvocations).toEqual(['success', 'failure']);

    const uninitializedOffline = await coordinator.refresh({
      source: 'cli-models',
      contextKey: 'cli|channel-a|generation-a',
      ttlMs: 1_000,
      mode: 'automatic',
      offline: true,
      load: () => {
        sourceInvocations.push('offline-without-snapshot');
        return Promise.resolve([]);
      },
      error: failedSource,
    });
    expect(uninitializedOffline).toEqual({
      kind: 'not-run',
      source: 'cli-models',
      contextKey: 'cli|channel-a|generation-a',
      reason: 'offline',
    });
    expect(sourceInvocations).toEqual(['success', 'failure']);
  });

  it('cancels superseded work and prevents late endpoint, channel, or generation results from publishing', async () => {
    const clock = createClock();
    const coordinator = createDetectionCoordinator({ now: clock.now });
    const oldResponse = deferred<DetectionProjection>();
    const newResponse = deferred<DetectionProjection>();
    let oldSignal: AbortSignal | undefined;
    const old = coordinator.refresh({
      source: 'readiness',
      contextKey: 'runner|endpoint-a|channel-a|generation-a',
      ttlMs: 1_000,
      mode: 'manual',
      load: (signal) => {
        oldSignal = signal;
        return oldResponse.promise;
      },
      error: failedSource,
    });
    const currentContext = 'runner|endpoint-b|channel-b|generation-b';
    const current = coordinator.refresh({
      source: 'readiness',
      contextKey: currentContext,
      ttlMs: 1_000,
      mode: 'manual',
      load: () => newResponse.promise,
      error: failedSource,
    });

    expect(oldSignal?.aborted).toBe(true);
    newResponse.resolve(readiness('new'));
    const currentResult = await current;
    oldResponse.resolve(readiness('old'));
    const oldResult = await old;

    expect(oldResult).toEqual({
      kind: 'not-run',
      source: 'readiness',
      contextKey: 'runner|endpoint-a|channel-a|generation-a',
      reason: 'superseded',
    });
    expect(currentResult).toMatchObject({ kind: 'fresh', origin: 'request' });
    if (currentResult.kind !== 'fresh') throw new Error('Expected the current request to publish.');
    expect(currentResult.snapshot.generation).toBeGreaterThan(1);
    expect(
      coordinator.snapshot({ source: 'readiness', contextKey: currentContext })?.value,
    ).toEqual(readiness('new'));
    expect(
      coordinator.snapshot({
        source: 'readiness',
        contextKey: 'runner|endpoint-a|channel-a|generation-a',
      }),
    ).toBeUndefined();

    const cancelledResponse = deferred<CliModelSnapshot>();
    let cancelledSignal: AbortSignal | undefined;
    const cancelled = coordinator.refresh({
      source: 'cli-models',
      contextKey: 'cli|channel-c|generation-c',
      ttlMs: 1_000,
      mode: 'manual',
      load: (signal) => {
        cancelledSignal = signal;
        return cancelledResponse.promise;
      },
      error: failedSource,
    });
    coordinator.cancel({ source: 'cli-models', contextKey: 'cli|channel-c|generation-c' });
    expect(cancelledSignal?.aborted).toBe(true);
    cancelledResponse.resolve([]);
    await expect(cancelled).resolves.toEqual({
      kind: 'not-run',
      source: 'cli-models',
      contextKey: 'cli|channel-c|generation-c',
      reason: 'cancelled',
    });
  });
});
