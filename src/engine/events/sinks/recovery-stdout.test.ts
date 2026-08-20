import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { parseEngineEvent } from '../schema.js';
import { HeadlessJsonRecordSchema } from '../public-json.js';
import type { EngineEvent } from '../types.js';
import { createStdoutJsonSink } from './stdout-json.js';

const briefHash = 'a'.repeat(64);
const reportHash = 'b'.repeat(64);
const secret = 'sk-ant-recovery-secret-81942';

const base = {
  ts: 100,
  phase: 'reviewing-briefs' as const,
  version: 1 as const,
  eventId: 'event-1',
  sessionId: 'session-1',
  epochId: 'epoch-1',
  recoveryRevision: 1,
  briefRevision: 3,
  briefHash,
  reportRevision: 2,
  reportHash,
};

function event(value: unknown): EngineEvent {
  const parsed = parseEngineEvent(value);
  if (parsed === null) throw new Error('expected a valid engine event fixture');
  return parsed;
}

function writeCapture() {
  const writes: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback): void {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      callback();
    },
  });
  return { output, writes };
}

function readLines(writes: readonly string[]) {
  return writes.map((line) => {
    expect(line).toMatch(/\n$/u);
    const parsed = HeadlessJsonRecordSchema.parse(JSON.parse(line.trimEnd()));
    expect(JSON.stringify(parsed)).not.toContain(secret);
    expect(JSON.stringify(parsed)).not.toContain('\u001b[');
    return parsed;
  });
}

describe('recovery stdout JSON sink', () => {
  it.each([
    event({
      ...base,
      type: 'brief_recovery_quality_reported',
      status: 'blocked',
      outcome: 'failed',
      taskCount: 0,
      issueCount: 1,
      errorCount: 1,
      warningCount: 0,
      issueCodes: ['empty_task_list'],
    }),
    event({
      ...base,
      type: 'brief_recovery_attempt_started',
      eventId: 'event-started',
      recoveryRevision: 2,
      operationId: 'retry-1',
      intentHash: briefHash,
      attemptKind: 'manual-retry',
      status: 'started',
      requestId: 'request-1',
      dispatchPossibility: 'possible',
      frozenInputCount: 0,
    }),
    event({
      ...base,
      type: 'brief_recovery_attempt_settled',
      eventId: 'event-ready',
      recoveryRevision: 3,
      operationId: 'retry-1',
      intentHash: briefHash,
      attemptKind: 'manual-retry',
      status: 'settled',
      resultId: 'result-1',
      outcome: 'ready',
      dispatchPossibility: 'possible',
      remoteObservation: 'confirmed-final',
      taskCount: 1,
      issueCount: 0,
      errorCount: 0,
      warningCount: 0,
    }),
    event({
      ...base,
      type: 'brief_recovery_provider_failed',
      eventId: 'event-provider',
      recoveryRevision: 4,
      operationId: 'retry-2',
      intentHash: reportHash,
      attemptKind: 'manual-retry',
      status: 'blocked',
      outcome: 'provider-failed',
      providerCode: 'provider-failed',
      refusalCategory: 'authentication',
      dispatchPossibility: 'none',
      remoteObservation: 'not-dispatched',
    }),
    event({
      ...base,
      type: 'brief_recovery_refused',
      eventId: 'event-storage',
      recoveryRevision: 5,
      status: 'storage-blocked',
      intentId: 'intent-storage',
      operationId: null,
      action: 'status',
      refusalCategory: 'storage',
      refusalCode: 'brief_storage_invalid',
    }),
    event({
      ...base,
      type: 'brief_recovery_attempt_unresolved',
      eventId: 'event-unresolved',
      recoveryRevision: 6,
      operationId: 'retry-3',
      intentHash: reportHash,
      attemptKind: 'manual-retry',
      status: 'unresolved',
      requestId: 'request-3',
      dispatchPossibility: 'possible',
      remoteObservation: 'unknown',
      refusalCategory: 'unresolved',
    }),
    event({
      ...base,
      type: 'brief_recovery_attempt_accepted',
      eventId: 'event-none',
      recoveryRevision: 7,
      operationId: 'retry-none',
      intentHash: briefHash,
      attemptKind: 'manual-retry',
      status: 'accepted',
      dispatchPossibility: 'none',
      frozenInputCount: 0,
      queuedInputCount: 0,
      automaticAllowanceConsumed: false,
    }),
    event({
      ...base,
      type: 'brief_recovery_attempt_settled',
      eventId: 'event-superseded',
      recoveryRevision: 8,
      operationId: 'retry-possible',
      intentHash: reportHash,
      attemptKind: 'manual-retry',
      status: 'settled',
      resultId: 'result-superseded',
      outcome: 'stale-ignored',
      dispatchPossibility: 'possible',
      remoteObservation: 'confirmed-final',
      refusalCategory: 'stale',
    }),
  ])('writes a protected machine-readable recovery record (%s)', (fixture) => {
    const { output, writes } = writeCapture();
    const sink = createStdoutJsonSink({ output, persistTranscript: false });

    sink(fixture);

    const [record] = readLines(writes);
    expect(record).toMatchObject({ type: 'event', data: { type: fixture.type } });
  });

  it('emits deterministic lines for duplicate event IDs without exposing input text', () => {
    const { output, writes } = writeCapture();
    const fixture = {
      ...event({
        ...base,
        type: 'brief_recovery_refused',
        refusalCode: 'brief_contract_blocked',
        intentId: 'intent-duplicate',
        operationId: null,
        action: 'approve',
        refusalCategory: 'quality',
        status: 'blocked',
      }),
      rawPrompt: `\u001b[31mprivate prompt ${secret}\u001b[0m`,
    } as EngineEvent;
    const sink = createStdoutJsonSink({ output, persistTranscript: false });

    sink(fixture);
    sink(fixture);

    const records = readLines(writes);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(records[1]);
    expect(records[0]).toMatchObject({
      type: 'event',
      data: {
        eventId: 'event-1',
        status: 'blocked',
        refusalCategory: 'quality',
      },
    });
  });

  it('turns an oversized valid event into a schema-valid protected warning', () => {
    const { output, writes } = writeCapture();
    const oversized = {
      ...base,
      type: 'brief_recovery_quality_reported',
      issueCount: 257,
      errorCount: 257,
      issueCodes: Array.from({ length: 257 }, (_value, index) => `issue-${index}`),
      outcome: 'failed',
      status: 'blocked',
      taskCount: 0,
      warningCount: 0,
    } as unknown as EngineEvent;
    const sink = createStdoutJsonSink({ output, persistTranscript: false });

    sink(oversized);

    const [record] = readLines(writes);
    expect(record).toMatchObject({
      type: 'event',
      data: { type: 'warning', category: 'protection', code: 'payload_omitted' },
    });
  });

  it('fails closed for malformed recovery variants without writing malformed JSON', () => {
    const { output, writes } = writeCapture();
    const sink = createStdoutJsonSink({ output, persistTranscript: false });

    sink({
      ...base,
      type: 'brief_recovery_future_variant',
      secret,
    } as unknown as EngineEvent);

    expect(writes).toEqual([]);
  });

  it('does not turn a broken stdout stream into an authority failure', () => {
    const output = new Writable({
      write(_chunk, _encoding, callback): void {
        callback();
      },
    });
    const write = vi.spyOn(output, 'write').mockImplementation(() => {
      throw new Error('stdout closed');
    });
    const sink = createStdoutJsonSink({ output });
    const fixture = event({
      ...base,
      type: 'brief_recovery_attempt_accepted',
      operationId: 'retry-broken-stream',
      intentHash: briefHash,
      attemptKind: 'manual-retry',
      status: 'accepted',
      dispatchPossibility: 'none',
      frozenInputCount: 0,
      queuedInputCount: 0,
      automaticAllowanceConsumed: false,
    });

    expect(() => sink(fixture)).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
