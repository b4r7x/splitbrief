import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { EngineEvent } from '../events/types.js';
import { parseEngineEvent } from '../events/schema.js';
import { parseJsonlLine } from '../../lib/fs.js';
import { isRecord } from '../../utils/type-guards.js';
import { CALL_SESSION_LOG_MAX_PUBLIC_PAYLOAD_BYTES } from '../calls/consumer-policy.js';

export type ReplayOptions = {
  sessionJsonlPath: string;
};

export type ReplayResult = {
  events: EngineEvent[];
  firstTs: number | null;
  lastTs: number | null;
  diagnostics: ReplayDiagnostics;
};

export type ReplaySummary = {
  totalEvents: number;
  firstTs: number | null;
  lastTs: number | null;
  diagnostics: ReplayDiagnostics;
};

export type ReplayDiagnostics = {
  totalLines: number;
  replayedEvents: number;
  skippedBlank: number;
  skippedNonEvent: number;
  skippedMalformed: number;
  skippedUnknown: number;
  skippedOversized: number;
};

type ReplayLineResult =
  | { kind: 'event'; event: EngineEvent }
  | { kind: 'skip'; reason: keyof Omit<ReplayDiagnostics, 'totalLines' | 'replayedEvents'> };

function createReplayDiagnostics(): ReplayDiagnostics {
  return {
    totalLines: 0,
    replayedEvents: 0,
    skippedBlank: 0,
    skippedNonEvent: 0,
    skippedMalformed: 0,
    skippedUnknown: 0,
    skippedOversized: 0,
  };
}

function entryToEvent(raw: unknown): ReplayLineResult {
  if (!isRecord(raw)) return { kind: 'skip', reason: 'skippedMalformed' };
  const entry = raw;
  if (entry['kind'] !== 'event') return { kind: 'skip', reason: 'skippedNonEvent' };
  const type = entry['type'];
  if (typeof type !== 'string') return { kind: 'skip', reason: 'skippedMalformed' };
  const tsRaw = entry['ts'];
  let ts: number;
  if (typeof tsRaw === 'string') {
    ts = new Date(tsRaw).getTime();
    if (Number.isNaN(ts)) return { kind: 'skip', reason: 'skippedMalformed' };
  } else if (typeof tsRaw === 'number') {
    ts = tsRaw;
  } else {
    return { kind: 'skip', reason: 'skippedMalformed' };
  }
  const data = isRecord(entry['data']) ? entry['data'] : {};
  const phase = entry['phase'];
  const taskId = entry['taskId'];
  if (type.length === 0) return { kind: 'skip', reason: 'skippedMalformed' };
  const candidate: Record<string, unknown> = { type, ts, ...data };
  if (phase !== undefined) candidate['phase'] = phase;
  if (taskId !== undefined) candidate['taskId'] = taskId;
  const event = parseEngineEvent(candidate);
  return event ? { kind: 'event', event } : { kind: 'skip', reason: 'skippedUnknown' };
}

export async function readReplayEvents(opts: ReplayOptions): Promise<ReplayResult> {
  const events: EngineEvent[] = [];
  const diagnostics = createReplayDiagnostics();
  for await (const event of streamReplayEventsWithDiagnostics(opts, diagnostics)) {
    events.push(event);
  }

  const first = events[0];
  const last = events[events.length - 1];
  const firstTs = first ? first.ts : null;
  const lastTs = last ? last.ts : null;

  return { events, firstTs, lastTs, diagnostics };
}

export async function* streamReplayEvents(opts: ReplayOptions): AsyncGenerator<EngineEvent> {
  yield* streamReplayEventsWithDiagnostics(opts, createReplayDiagnostics());
}

async function* streamReplayEventsWithDiagnostics(
  opts: ReplayOptions,
  diagnostics: ReplayDiagnostics,
): AsyncGenerator<EngineEvent> {
  const { sessionJsonlPath } = opts;

  if (!existsSync(sessionJsonlPath)) return;

  const stream = createReadStream(sessionJsonlPath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    diagnostics.totalLines += 1;
    if (Buffer.byteLength(line, 'utf8') > CALL_SESSION_LOG_MAX_PUBLIC_PAYLOAD_BYTES) {
      diagnostics.skippedOversized += 1;
      continue;
    }
    const result = parseJsonlLine(line);
    if (result.kind === 'blank') {
      diagnostics.skippedBlank += 1;
      continue;
    }
    if (result.kind === 'corrupt') {
      diagnostics.skippedMalformed += 1;
      continue;
    }
    const event = entryToEvent(result.value);
    if (event.kind === 'skip') {
      diagnostics[event.reason] += 1;
      continue;
    }
    diagnostics.replayedEvents += 1;
    yield event.event;
  }
}

export async function summarizeReplayEvents(opts: ReplayOptions): Promise<ReplaySummary> {
  const diagnostics = createReplayDiagnostics();
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for await (const event of streamReplayEventsWithDiagnostics(opts, diagnostics)) {
    firstTs ??= event.ts;
    lastTs = event.ts;
  }

  return { totalEvents: diagnostics.replayedEvents, firstTs, lastTs, diagnostics };
}
