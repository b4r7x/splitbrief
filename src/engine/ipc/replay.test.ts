import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readReplayEvents } from './replay.js';
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

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'replay-test-'));
  tmpDirs.push(dir);
  return dir;
}

describe('readReplayEvents', () => {
  it('returns empty result for nonexistent file', async () => {
    const result = await readReplayEvents({ sessionJsonlPath: '/nonexistent/path/session.jsonl' });
    expect(result).toEqual({ events: [], count: 0, firstTs: null, lastTs: null });
  });

  it('returns all events from a valid session.jsonl', async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'session.jsonl');
    const events: EngineEvent[] = [
      { type: 'workflow_started', ts: 1000, phase: 'idle', feature: 'test' },
      { type: 'workflow_complete', ts: 2000, phase: 'idle' },
      { type: 'warning', ts: 3000, phase: 'idle', message: 'something' },
    ];
    writeFileSync(filePath, events.map(makeSessionEntry).join('\n') + '\n');

    const result = await readReplayEvents({ sessionJsonlPath: filePath });
    expect(result.count).toBe(3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0]!.type).toBe('workflow_started');
    expect(result.events[2]!.type).toBe('warning');
    expect(result.firstTs).toBe(1000);
    expect(result.lastTs).toBe(3000);
  });

  it('skips malformed JSON lines and returns valid events around them', async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'session.jsonl');
    const lines = [
      makeSessionEntry({ type: 'workflow_started', ts: 1000, phase: 'idle', feature: 'test' }),
      'this is not valid json at all!!!',
      makeSessionEntry({ type: 'workflow_complete', ts: 3000, phase: 'idle' }),
    ];
    writeFileSync(filePath, lines.join('\n') + '\n');

    const result = await readReplayEvents({ sessionJsonlPath: filePath });
    expect(result.count).toBe(2);
    expect(result.events[0]!.type).toBe('workflow_started');
    expect(result.events[1]!.type).toBe('workflow_complete');
  });

  it('applies fromTs filter and only returns events with ts >= fromTs', async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'session.jsonl');
    const events: EngineEvent[] = [
      { type: 'workflow_started', ts: 1000, phase: 'idle', feature: 'test' },
      { type: 'warning', ts: 2000, phase: 'idle', message: 'a' },
      { type: 'workflow_complete', ts: 3000, phase: 'idle' },
    ];
    writeFileSync(filePath, events.map(makeSessionEntry).join('\n') + '\n');

    const result = await readReplayEvents({ sessionJsonlPath: filePath, fromTs: 2000 });
    expect(result.count).toBe(2);
    expect(result.events[0]!.ts).toBe(2000);
    expect(result.events[1]!.ts).toBe(3000);
  });

  it('firstTs and lastTs reflect the filtered set', async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'session.jsonl');
    const events: EngineEvent[] = [
      { type: 'workflow_started', ts: 1000, phase: 'idle', feature: 'test' },
      { type: 'warning', ts: 2500, phase: 'idle', message: 'b' },
      { type: 'workflow_complete', ts: 5000, phase: 'idle' },
    ];
    writeFileSync(filePath, events.map(makeSessionEntry).join('\n') + '\n');

    const result = await readReplayEvents({ sessionJsonlPath: filePath, fromTs: 2000 });
    expect(result.firstTs).toBe(2500);
    expect(result.lastTs).toBe(5000);
  });

  it('handles large files (>1000 lines) using streaming readline', async () => {
    const dir = makeTmpDir();
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
    expect(result.count).toBe(1200);
    expect(result.firstTs).toBe(0);
    expect(result.lastTs).toBe(1199 * 1000);
  });

  it('returns empty result when all events filtered out by fromTs', async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'session.jsonl');
    const events: EngineEvent[] = [
      { type: 'workflow_started', ts: 1000, phase: 'idle', feature: 'test' },
    ];
    writeFileSync(filePath, events.map(makeSessionEntry).join('\n') + '\n');

    const result = await readReplayEvents({ sessionJsonlPath: filePath, fromTs: 9999 });
    expect(result.count).toBe(0);
    expect(result.firstTs).toBeNull();
    expect(result.lastTs).toBeNull();
  });

  it('skips lines with kind !== event', async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'session.jsonl');
    const messageLine = JSON.stringify({ kind: 'message', ts: new Date(500).toISOString(), role: 'user', phase: 'idle', text: 'hello' });
    const eventLine = makeSessionEntry({ type: 'workflow_started', ts: 1000, phase: 'idle', feature: 'test' });
    writeFileSync(filePath, [messageLine, eventLine].join('\n') + '\n');

    const result = await readReplayEvents({ sessionJsonlPath: filePath });
    expect(result.count).toBe(1);
    expect(result.events[0]!.type).toBe('workflow_started');
  });
});
