import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { readReplayEvents } from './replay.js';
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

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

describe('readReplayEvents', () => {
  it('returns empty result for nonexistent file', async () => {
    const result = await readReplayEvents({ sessionJsonlPath: '/nonexistent/path/session.jsonl' });
    expect(result).toEqual({
      events: [],
      firstTs: null,
      lastTs: null,
      diagnostics: emptyDiagnostics,
    });
  });

  it('returns all events from a valid session.jsonl', async () => {
    const dir = createTempDir('replay-test');
    tmpDirs.push(dir);
    const filePath = join(dir, 'session.jsonl');
    const events: EngineEvent[] = [
      { type: 'workflow_started', ts: 1000, phase: 'idle', feature: 'test' },
      { type: 'workflow_complete', ts: 2000, phase: 'idle' },
      { type: 'warning', ts: 3000, phase: 'idle', message: 'something' },
    ];
    writeFileSync(filePath, events.map(makeSessionEntry).join('\n') + '\n');

    const result = await readReplayEvents({ sessionJsonlPath: filePath });
    expect(result.events).toHaveLength(3);
    expect(result.events[0]!.type).toBe('workflow_started');
    expect(result.events[2]!.type).toBe('warning');
    expect(result.firstTs).toBe(1000);
    expect(result.lastTs).toBe(3000);
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

    const result = await readReplayEvents({ sessionJsonlPath: filePath });
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.type).toBe('workflow_started');
    expect(result.events[1]!.type).toBe('workflow_complete');
    expect(result.diagnostics).toMatchObject({
      totalLines: 3,
      replayedEvents: 2,
      skippedMalformed: 1,
    });
  });

  it('handles large files (>1000 lines) using streaming readline', async () => {
    const dir = createTempDir('replay-test');
    tmpDirs.push(dir);
    const filePath = join(dir, 'session.jsonl');
    // Write 1200 events with enough data per line to exceed typical buffer sizes
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

    const result = await readReplayEvents({ sessionJsonlPath: filePath });
    expect(result.events).toHaveLength(1200);
    expect(result.firstTs).toBe(0);
    expect(result.lastTs).toBe(1199 * 1000);
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

    const result = await readReplayEvents({ sessionJsonlPath: filePath });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('workflow_started');
    expect(result.diagnostics).toMatchObject({
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

    const result = await readReplayEvents({ sessionJsonlPath: filePath });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('workflow_started');
    expect(result.diagnostics).toMatchObject({
      totalLines: 3,
      replayedEvents: 1,
      skippedUnknown: 1,
      skippedOversized: 1,
    });
  });
});
