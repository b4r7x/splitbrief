import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { EngineEvent } from '../events/types.js';
import { parseEngineEvent } from '../events/schema.js';
import { isRecord } from '../../utils/type-guards.js';

export type ReplayOptions = {
  sessionJsonlPath: string;
};

export type ReplayResult = {
  events: EngineEvent[];
  firstTs: number | null;
  lastTs: number | null;
};

export type ReplaySummary = {
  totalEvents: number;
  firstTs: number | null;
  lastTs: number | null;
};

function entryToEvent(raw: unknown): EngineEvent | null {
  if (!isRecord(raw)) return null;
  const entry = raw;
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
  const data = isRecord(entry['data']) ? entry['data'] : {};
  const phase = entry['phase'];
  const taskId = entry['taskId'];
  if (type.length === 0) return null;
  const candidate: Record<string, unknown> = { type, ts, ...data };
  if (phase !== undefined) candidate['phase'] = phase;
  if (taskId !== undefined) candidate['taskId'] = taskId;
  return parseEngineEvent(candidate);
}

export async function readReplayEvents(opts: ReplayOptions): Promise<ReplayResult> {
  const events: EngineEvent[] = [];
  for await (const event of streamReplayEvents(opts)) {
    events.push(event);
  }

  const first = events[0];
  const last = events[events.length - 1];
  const firstTs = first ? first.ts : null;
  const lastTs = last ? last.ts : null;

  return { events, firstTs, lastTs };
}

export async function* streamReplayEvents(opts: ReplayOptions): AsyncGenerator<EngineEvent> {
  const { sessionJsonlPath } = opts;

  if (!existsSync(sessionJsonlPath)) return;

  const stream = createReadStream(sessionJsonlPath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

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
    yield event;
  }
}

export async function summarizeReplayEvents(opts: ReplayOptions): Promise<ReplaySummary> {
  let totalEvents = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for await (const event of streamReplayEvents(opts)) {
    firstTs ??= event.ts;
    lastTs = event.ts;
    totalEvents += 1;
  }

  return { totalEvents, firstTs, lastTs };
}
