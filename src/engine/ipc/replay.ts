import { createReadStream, existsSync } from 'node:fs';
import * as readline from 'node:readline';
import type { EngineEvent } from '../events/types.js';

export type ReplayOptions = {
  sessionJsonlPath: string;
  fromTs?: number;
};

export type ReplayResult = {
  events: EngineEvent[];
  count: number;
  firstTs: number | null;
  lastTs: number | null;
};

function entryToEvent(raw: unknown): EngineEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (entry['kind'] !== 'event') return null;
  const type = entry['type'];
  if (typeof type !== 'string') return null;
  const tsRaw = entry['ts'];
  let ts: number;
  if (typeof tsRaw === 'string') {
    ts = new Date(tsRaw).getTime();
    if (Number.isNaN(ts)) return null;
  } else if (typeof tsRaw === 'number') {
    ts = tsRaw;
  } else {
    return null;
  }
  const data = typeof entry['data'] === 'object' && entry['data'] !== null
    ? entry['data'] as Record<string, unknown>
    : {};
  const phase = entry['phase'];
  const taskId = entry['taskId'];
  const event: Record<string, unknown> = { type, ts, ...data };
  if (phase !== undefined) event['phase'] = phase;
  if (taskId !== undefined) event['taskId'] = taskId;
  return event as unknown as EngineEvent;
}

export async function readReplayEvents(opts: ReplayOptions): Promise<ReplayResult> {
  const { sessionJsonlPath, fromTs } = opts;

  if (!existsSync(sessionJsonlPath)) {
    return { events: [], count: 0, firstTs: null, lastTs: null };
  }

  const events: EngineEvent[] = [];
  const stream = createReadStream(sessionJsonlPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const event = entryToEvent(raw);
    if (!event) continue;
    if (fromTs !== undefined && event.ts < fromTs) continue;
    events.push(event);
  }

  const first = events[0];
  const last = events[events.length - 1];
  const firstTs = first ? first.ts : null;
  const lastTs = last ? last.ts : null;

  return { events, count: events.length, firstTs, lastTs };
}
