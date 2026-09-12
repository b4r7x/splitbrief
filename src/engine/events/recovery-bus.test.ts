import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createEventBus } from './bus.js';
import { parseEngineEvent } from './schema.js';
import { HeadlessJsonRecordSchema } from './public-json.js';
import { createStdoutJsonSink } from './sinks/stdout-json.js';
import type { EngineEvent } from './types.js';

const SECRET = 'sk-ant-recovery-secret-81942';

function recoveryEvent(overrides: Record<string, unknown> = {}): EngineEvent {
  const parsed = parseEngineEvent({
    type: 'recovery_prompted',
    ts: 100,
    phase: 'reviewing-briefs',
    issueId: 'issue-1',
    reason: 'context-overflow',
    files: [],
    affectedTaskIds: [],
    availableActions: ['pause-run', 'abort-workflow'],
    recommendedAction: 'pause-run',
    ...overrides,
  });
  if (parsed === null) {
    throw new Error('expected a valid recovery event fixture');
  }
  return parsed;
}

function writeCapture(): { output: NodeJS.WritableStream; writes: string[] } {
  const writes: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback): void {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      callback();
    },
  });
  return { output, writes };
}

function readRecords(writes: readonly string[]) {
  return writes.map((line) => {
    expect(line).toMatch(/\n$/u);
    const record = HeadlessJsonRecordSchema.parse(JSON.parse(line.trimEnd()));
    expect(JSON.stringify(record)).not.toContain(SECRET);
    return record;
  });
}

describe('recovery EventBus boundary', () => {
  it('delivers an ordinary recovery event and writes one protected record', () => {
    const bus = createEventBus();
    const { output, writes } = writeCapture();
    const seen: EngineEvent[] = [];
    bus.subscribe((event) => seen.push(event));
    bus.subscribe(createStdoutJsonSink({ output }));

    bus.publish(recoveryEvent({ prompt: SECRET, providerPayload: SECRET }));

    const records = readRecords(writes);
    expect(records).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'event',
      data: {
        type: 'recovery_prompted',
        issueId: 'issue-1',
        reason: 'context-overflow',
        recommendedAction: 'pause-run',
      },
    });
  });

  it('fails closed for direct-invalid recovery records without publishing raw content', () => {
    const bus = createEventBus();
    const { output, writes } = writeCapture();
    bus.subscribe(createStdoutJsonSink({ output }));

    bus.publish({
      type: 'recovery_prompted',
      ts: 1,
      phase: 'reviewing-briefs',
      issueId: 'issue-1',
      secret: SECRET,
    } as unknown as EngineEvent);

    const records = readRecords(writes);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'event',
      data: { type: 'warning', category: 'payload-bounds', code: 'payload_omitted' },
    });
  });

  it('does not deduplicate or reinterpret duplicate and conflicting protected IDs', () => {
    const bus = createEventBus();
    const { output, writes } = writeCapture();
    bus.subscribe(createStdoutJsonSink({ output }));
    const event = recoveryEvent();
    const conflicting = recoveryEvent({ recommendedAction: 'abort-workflow' });

    bus.publish(event);
    bus.publish(event);
    bus.publish(conflicting);

    const records = readRecords(writes);
    expect(records).toHaveLength(3);
    const issueIds = records.map((record) => {
      if (record.type !== 'event' || !('issueId' in record.data)) {
        throw new Error('expected a protected event record');
      }
      return record.data.issueId;
    });
    expect(issueIds).toEqual(['issue-1', 'issue-1', 'issue-1']);
    expect(records[2]).toMatchObject({
      type: 'event',
      data: { recommendedAction: 'abort-workflow' },
    });
  });

  it('keeps subscriber failures non-authoritative and continues delivery', () => {
    const bus = createEventBus();
    const { output, writes } = writeCapture();
    let subscriberCalls = 0;
    bus.subscribe(() => {
      subscriberCalls += 1;
      throw new Error('projection failed');
    });
    bus.subscribe(createStdoutJsonSink({ output }));

    expect(() => bus.publish(recoveryEvent())).not.toThrow();
    expect(subscriberCalls).toBe(1);
    expect(readRecords(writes)).toHaveLength(1);
  });
});
