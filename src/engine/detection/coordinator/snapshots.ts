import { deepFreeze } from '../../../utils/deep-freeze.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { DetectionSourceId, DetectionSourceError, DetectionSourceSnapshot } from '../types.js';

export function copySourceValue<Value extends object>(
  source: DetectionSourceId,
  value: Value,
): Value {
  switch (source) {
    case 'models-dev':
      return deepFreeze(value);
    case 'readiness':
    case 'cli-models':
      return structuredClone(value);
    default:
      return assertNever(source);
  }
}

export function cloneError(error: DetectionSourceError): DetectionSourceError {
  return { kind: error.kind, message: error.message };
}

export function cloneSnapshot<Value extends object>(
  snapshot: DetectionSourceSnapshot<Value>,
): DetectionSourceSnapshot<Value> {
  return {
    source: snapshot.source,
    contextKey: snapshot.contextKey,
    generation: snapshot.generation,
    requestId: snapshot.requestId,
    fetchedAt: snapshot.fetchedAt,
    validatedAt: snapshot.validatedAt,
    stale: snapshot.stale,
    value: copySourceValue(snapshot.source, snapshot.value),
    ...(snapshot.error === undefined ? {} : { error: cloneError(snapshot.error) }),
  };
}

export function freshSnapshot(snapshot: DetectionSourceSnapshot<object>): boolean {
  return !snapshot.stale;
}

export function withinTtl(
  input: Readonly<{ snapshot: DetectionSourceSnapshot<object>; now: number; ttlMs: number }>,
): boolean {
  return input.now - input.snapshot.fetchedAt < Math.max(0, input.ttlMs);
}

export function staleSnapshot(
  input: Readonly<{
    snapshot: DetectionSourceSnapshot<object>;
    generation: number;
    requestId: number;
    validatedAt: number;
    error: DetectionSourceError;
  }>,
): DetectionSourceSnapshot<object> {
  return {
    source: input.snapshot.source,
    contextKey: input.snapshot.contextKey,
    generation: input.generation,
    requestId: input.requestId,
    fetchedAt: input.snapshot.fetchedAt,
    validatedAt: input.validatedAt,
    stale: true,
    value: copySourceValue(input.snapshot.source, input.snapshot.value),
    error: cloneError(input.error),
  };
}

export function offlineError(): DetectionSourceError {
  return { kind: 'offline', message: 'Discovery is offline.' };
}
