import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { streamReplayEvents, summarizeReplayEvents } from './replay.js';
import { CALL_SESSION_LOG_MAX_PUBLIC_PAYLOAD_BYTES } from '../../core/consumer-policy.js';
import type { EngineEvent } from '../events/types.js';

function makeSessionEntry(event: EngineEvent): string {
  const { type, ts, ...rest } = event;
  const phase = 'phase' in event ? (event as { phase: unknown }).phase : undefined;
  const taskId = 'taskId' in event ? (event as { taskId?: unknown }).taskId : undefined;
  const data = { ...rest };
  if ('phase' in data) delete (data as Record<string, unknown>)['phase'];
  if ('taskId' in data) delete (data as Record<string, unknown>)['taskId'];
  return JSON.stringify({
    kind: 'event',
    ts: new Date(ts).toISOString(),
    type,
    ...(phase !== undefined && { phase }),
    ...(taskId !== undefined && { taskId }),
    data,
  });
}

const tmpDirs: string[] = [];

const emptyDiagnostics = {
  totalLines: 0,
  replayedEvents: 0,
  skippedBlank: 0,
  skippedNonEvent: 0,
  skippedMalformed: 0,
  skippedUnknown: 0,
  skippedOversized: 0,
};

async function collectReplayEvents(sessionJsonlPath: string): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of streamReplayEvents({ sessionJsonlPath })) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

describe('session replay', () => {
  it('returns empty result for nonexistent file', async () => {
    const sessionJsonlPath = '/nonexistent/path/session.jsonl';
    await expect(collectReplayEvents(sessionJsonlPath)).resolves.toEqual([]);
    await expect(summarizeReplayEvents({ sessionJsonlPath })).resolves.toEqual({
      totalEvents: 0,
      firstTs: null,
      lastTs: null,
      diagnostics: emptyDiagnostics,
    });
  });

  it('returns all events from a valid session.jsonl', async () => {
    const dir = createTempDir('replay-test');
    tmpDirs.push(dir);
    const filePath = join(dir, 'session.jsonl');
    const fixtureEvents: EngineEvent[] = [
      { type: 'workflow_started', ts: 1000, phase: 'idle', feature: 'test' },
      { type: 'workflow_complete', ts: 2000, phase: 'idle' },
      { type: 'warning', ts: 3000, phase: 'idle', message: 'something' },
    ];
    writeFileSync(filePath, fixtureEvents.map(makeSessionEntry).join('\n') + '\n');

    const events = await collectReplayEvents(filePath);
    const summary = await summarizeReplayEvents({ sessionJsonlPath: filePath });

    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe('workflow_started');
    expect(events[2]!.type).toBe('warning');
    expect(summary.firstTs).toBe(1000);
    expect(summary.lastTs).toBe(3000);
  });

  it('preserves runner text semantics through session replay', async () => {
    const dir = createTempDir('replay-test');
    tmpDirs.push(dir);
    const filePath = join(dir, 'session.jsonl');
    writeFileSync(
      filePath,
      `${makeSessionEntry({
        type: 'runner_call_text_delta',
        ts: 1000,
        phase: 'planning',
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        sequence: 1,
        channel: 'result',
        text: 'final answer',
        semantics: 'final',
      })}\n`,
    );

    const events = await collectReplayEvents(filePath);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'runner_call_text_delta',
        channel: 'result',
        text: 'final answer',
        semantics: 'final',
      }),
    ]);
  });

  it('skips malformed JSON lines and returns valid events around them', async () => {
    const dir = createTempDir('replay-test');
    tmpDirs.push(dir);
    const filePath = join(dir, 'session.jsonl');
    const lines = [
      makeSessionEntry({ type: 'workflow_started', ts: 1000, phase: 'idle', feature: 'test' }),
      'this is not valid json at all!!!',
      makeSessionEntry({ type: 'workflow_complete', ts: 3000, phase: 'idle' }),
    ];
    writeFileSync(filePath, lines.join('\n') + '\n');

    const events = await collectReplayEvents(filePath);
    const summary = await summarizeReplayEvents({ sessionJsonlPath: filePath });

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('workflow_started');
    expect(events[1]!.type).toBe('workflow_complete');
    expect(summary.diagnostics).toMatchObject({
      totalLines: 3,
      replayedEvents: 2,
      skippedMalformed: 1,
    });
  });

  it('handles large files (>1000 lines) with bounded streaming reads', async () => {
    const dir = createTempDir('replay-test');
    tmpDirs.push(dir);
    const filePath = join(dir, 'session.jsonl');
    // Write 1200 events with enough data per line to exercise chunk boundaries.
    const lines: string[] = [];
    for (let i = 0; i < 1200; i++) {
      const entry = {
        kind: 'event',
        ts: new Date(i * 1000).toISOString(),
        type: 'warning',
        phase: 'idle',
        data: { message: `event-${i}-${'x'.repeat(200)}` },
      };
      lines.push(JSON.stringify(entry));
    }
    writeFileSync(filePath, lines.join('\n') + '\n');

    const events = await collectReplayEvents(filePath);
    const summary = await summarizeReplayEvents({ sessionJsonlPath: filePath });

    expect(events).toHaveLength(1200);
    expect(summary.firstTs).toBe(0);
    expect(summary.lastTs).toBe(1199 * 1000);
  });

  it('skips lines with kind !== event', async () => {
    const dir = createTempDir('replay-test');
    tmpDirs.push(dir);
    const filePath = join(dir, 'session.jsonl');
    const messageLine = JSON.stringify({
      kind: 'message',
      ts: new Date(500).toISOString(),
      role: 'user',
      phase: 'idle',
      text: 'hello',
    });
    const eventLine = makeSessionEntry({
      type: 'workflow_started',
      ts: 1000,
      phase: 'idle',
      feature: 'test',
    });
    writeFileSync(filePath, [messageLine, eventLine].join('\n') + '\n');

    const events = await collectReplayEvents(filePath);
    const summary = await summarizeReplayEvents({ sessionJsonlPath: filePath });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('workflow_started');
    expect(summary.diagnostics).toMatchObject({
      totalLines: 2,
      replayedEvents: 1,
      skippedNonEvent: 1,
    });
  });

  it('reports unknown future events and oversized records', async () => {
    const dir = createTempDir('replay-test');
    tmpDirs.push(dir);
    const filePath = join(dir, 'session.jsonl');
    const unknownLine = JSON.stringify({
      kind: 'event',
      ts: new Date(500).toISOString(),
      type: 'future_event',
      phase: 'idle',
      data: {},
    });
    const oversizedLine = 'x'.repeat(CALL_SESSION_LOG_MAX_PUBLIC_PAYLOAD_BYTES + 1);
    const eventLine = makeSessionEntry({
      type: 'workflow_started',
      ts: 1000,
      phase: 'idle',
      feature: 'test',
    });
    writeFileSync(filePath, [unknownLine, oversizedLine, eventLine].join('\n') + '\n');

    const events = await collectReplayEvents(filePath);
    const summary = await summarizeReplayEvents({ sessionJsonlPath: filePath });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('workflow_started');
    expect(summary.diagnostics).toMatchObject({
      totalLines: 3,
      replayedEvents: 1,
      skippedUnknown: 1,
      skippedOversized: 1,
    });
  });

  it('skips an oversized unterminated replay tail without waiting for a newline', async () => {
    const dir = createTempDir('replay-test');
    tmpDirs.push(dir);
    const filePath = join(dir, 'session.jsonl');
    writeFileSync(filePath, 'x'.repeat(33));

    await expect(collectReplayEvents(filePath)).resolves.toEqual([]);
    await expect(
      summarizeReplayEvents({ sessionJsonlPath: filePath, maxLineBytes: 32 }),
    ).resolves.toMatchObject({
      totalEvents: 0,
      diagnostics: { totalLines: 1, skippedOversized: 1 },
    });
  });

  it('enforces replay event and byte budgets before parsing unbounded history', async () => {
    const dir = createTempDir('replay-test');
    tmpDirs.push(dir);
    const filePath = join(dir, 'session.jsonl');
    const lines = Array.from({ length: 4 }, (_, index) =>
      makeSessionEntry({
        type: 'warning',
        ts: index + 1,
        phase: 'idle',
        message: `event-${index}`,
      }),
    );
    writeFileSync(filePath, `${lines.join('\n')}\n`);

    const eventLimited = await collectReplayEventsWithOptions(filePath, { maxEvents: 2 });
    expect(eventLimited).toHaveLength(2);

    const firstLineBytes = Buffer.byteLength(`${lines[0]}\n`, 'utf8');
    const exactlyOneLine = await collectReplayEventsWithOptions(filePath, {
      maxBytes: firstLineBytes,
    });
    expect(exactlyOneLine).toHaveLength(1);

    const byteLimited = await collectReplayEventsWithOptions(filePath, {
      maxBytes: firstLineBytes + 1,
    });
    expect(byteLimited).toHaveLength(1);
  });
});

async function collectReplayEventsWithOptions(
  sessionJsonlPath: string,
  options: { maxEvents?: number; maxBytes?: number },
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of streamReplayEvents({ sessionJsonlPath, ...options })) {
    events.push(event);
  }
  return events;
}
