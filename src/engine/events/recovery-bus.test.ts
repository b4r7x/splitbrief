import { afterEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createEventBus } from './bus.js';
import { parseEngineEvent } from './schema.js';
import { HeadlessJsonRecordSchema } from './public-json.js';
import { createStdoutJsonSink } from './sinks/stdout-json.js';
import type { EngineEvent } from './types.js';
import {
  drainRecoveryOutbox,
  persistRecoveryTransition,
} from '../orchestrator/evidence/persistence.js';
import { createBriefRecoveryState } from '../orchestrator/planning/brief-recovery.js';
import { createInitialState } from '../../core/state/machine.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
} from '#testing/helpers/orchestrator-task-context.js';

const BRIEF_HASH = 'a'.repeat(64);
const REPORT_HASH = 'b'.repeat(64);
const SECRET = 'sk-ant-recovery-secret-81942';

const base = {
  ts: 100,
  phase: 'reviewing-briefs' as const,
  version: 1 as const,
  eventId: 'event-1',
  sessionId: 'session-recovery',
  epochId: 'epoch-recovery',
  recoveryRevision: 1,
  briefRevision: 3,
  briefHash: BRIEF_HASH,
  reportRevision: 2,
  reportHash: REPORT_HASH,
};

type RefusedRecoveryEvent = Extract<EngineEvent, { type: 'brief_recovery_refused' }>;

function recoveryEvent(overrides: Record<string, unknown> = {}): RefusedRecoveryEvent {
  const parsed = parseEngineEvent({
    ...base,
    type: 'brief_recovery_refused',
    intentId: 'intent-1',
    operationId: null,
    action: 'approve',
    refusalCategory: 'quality',
    refusalCode: 'brief_contract_blocked',
    status: 'blocked',
    ...overrides,
  });
  if (parsed === null || parsed.type !== 'brief_recovery_refused') {
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

function recoveryState(): WorkflowState {
  const activeBrief = { revision: 1, hash: BRIEF_HASH, path: 'brief.json' };
  const report = { revision: 1, hash: REPORT_HASH, path: 'report.json' };
  return {
    ...createInitialState('feat'),
    phase: 'reviewing-briefs',
    briefRecovery: createBriefRecoveryState(
      {
        sessionId: 'session-recovery',
        origin: { mode: 'standard', entry: 'initial' },
        continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
        activeBrief,
        report: {
          briefHash: activeBrief.hash,
          report,
          ruleVersion: 'quality-v1',
          issues: [],
          errorCount: 0,
        },
        qualityPolicyVersion: 'quality-v1',
      },
      { epochId: 'epoch-recovery' },
    ),
  };
}

function persistedRecoveryFixture(): {
  ref: { projectDir: string; sessionId: string };
  state: WorkflowState;
} {
  const context = makeTaskWorkflowContext();
  const state = recoveryState();
  saveState(context, state);
  return {
    ref: { projectDir: context.projectDir, sessionId: context.sessionId },
    state,
  };
}

afterEach(() => {
  cleanupTaskProjects();
});

describe('recovery EventBus boundary', () => {
  it('delivers one protected projection and preserves its event identity', () => {
    const bus = createEventBus();
    const { output, writes } = writeCapture();
    const seen: EngineEvent[] = [];
    bus.subscribe((event) => seen.push(event));
    bus.subscribe(createStdoutJsonSink({ output, persistTranscript: true }));

    const event = recoveryEvent();
    const hostileEvent = {
      ...event,
      prompt: SECRET,
      providerPayload: SECRET,
    } as unknown as EngineEvent;

    bus.publish(hostileEvent);

    const records = readRecords(writes);
    expect(records).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toContain(SECRET);
    expect(seen[0]).toMatchObject({ eventId: event.eventId, epochId: event.epochId });
    expect(records[0]).toMatchObject({
      type: 'event',
      data: {
        type: event.type,
        eventId: event.eventId,
        sessionId: event.sessionId,
        epochId: event.epochId,
        refusalCategory: 'quality',
      },
    });
  });

  it('fails closed for direct-invalid recovery records without publishing raw content', () => {
    const bus = createEventBus();
    const { output, writes } = writeCapture();
    bus.subscribe(createStdoutJsonSink({ output, persistTranscript: true }));

    bus.publish({
      ...base,
      type: 'brief_recovery_future_variant',
      secret: SECRET,
    } as unknown as EngineEvent);

    expect(writes).toEqual([]);
  });

  it('does not deduplicate or reinterpret duplicate and conflicting protected IDs', () => {
    const bus = createEventBus();
    const { output, writes } = writeCapture();
    bus.subscribe(createStdoutJsonSink({ output, persistTranscript: true }));
    const event = recoveryEvent();
    const conflicting = {
      ...event,
      refusalCategory: 'provider',
      refusalCode: 'provider_failed',
      rawPrompt: SECRET,
    } as unknown as EngineEvent;

    bus.publish(event);
    bus.publish(event);
    bus.publish(conflicting);

    const records = readRecords(writes);
    expect(records).toHaveLength(3);
    const eventIds = records.map((record) => {
      if (record.type !== 'event' || !('eventId' in record.data)) {
        throw new Error('expected a protected event record');
      }
      return record.data.eventId;
    });
    expect(eventIds).toEqual(['event-1', 'event-1', 'event-1']);
    expect(records[2]).toMatchObject({
      type: 'event',
      data: { refusalCategory: 'provider', refusalCode: 'provider_failed' },
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
    bus.subscribe(createStdoutJsonSink({ output, persistTranscript: true }));

    expect(() => bus.publish(recoveryEvent())).not.toThrow();
    expect(subscriberCalls).toBe(1);
    expect(readRecords(writes)).toHaveLength(1);
  });

  it('publishes only after the committed evidence/state outbox and replays after a crash', () => {
    const fixture = persistedRecoveryFixture();
    const bus = createEventBus();
    const { output, writes } = writeCapture();
    bus.subscribe(createStdoutJsonSink({ output, persistTranscript: true }));
    const event = recoveryEvent({ eventId: 'event-after-commit' });

    expect(() =>
      persistRecoveryTransition({
        ref: fixture.ref,
        state: fixture.state,
        nextState: fixture.state,
        epochId: fixture.state.briefRecovery?.epochId ?? 'epoch-recovery',
        kind: 'outcome',
        eventId: event.eventId,
        payload: event,
        bus,
        onFault: (point) => {
          if (point === 'after-state-commit') throw new Error('injected crash');
        },
      }),
    ).toThrow('injected crash');

    expect(writes).toEqual([]);
    expect(loadState(fixture.ref)?.briefRecovery?.outbox).toEqual([
      expect.objectContaining({ eventId: event.eventId, acknowledged: false }),
    ]);

    const replay = drainRecoveryOutbox({ ref: fixture.ref, bus });
    expect(replay.deliveredEventIds).toEqual([event.eventId]);
    expect(replay.acknowledgedEventIds).toEqual([event.eventId]);
    expect(readRecords(writes)).toHaveLength(1);
    expect(loadState(fixture.ref)?.briefRecovery?.outbox[0]?.acknowledged).toBe(true);
  });

  it('turns oversized recovery payloads into one protected warning', () => {
    const bus = createEventBus();
    const { output, writes } = writeCapture();
    bus.subscribe(createStdoutJsonSink({ output, persistTranscript: true }));

    bus.publish({
      ...base,
      type: 'brief_recovery_quality_reported',
      issueCount: 257,
      errorCount: 257,
      warningCount: 0,
      taskCount: 0,
      outcome: 'failed',
      status: 'blocked',
      issueCodes: Array.from({ length: 257 }, (_value, index) => `issue-${index}`),
      prompt: SECRET,
    } as unknown as EngineEvent);

    const records = readRecords(writes);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'event',
      data: { type: 'warning', category: 'protection', code: 'payload_omitted' },
    });
  });
});
