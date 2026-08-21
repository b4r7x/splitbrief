import { createReadStream, existsSync } from 'node:fs';
import type { EngineEvent } from '../events/types.js';
import { parseEngineEvent } from '../events/schema.js';
import { parseJsonlLine } from '../../lib/fs.js';
import { isRecord } from '../../utils/type-guards.js';
import { CALL_SESSION_LOG_MAX_PUBLIC_PAYLOAD_BYTES } from '../../core/consumer-policy.js';

export const REPLAY_MAX_EVENTS = 100_000;
export const REPLAY_MAX_BYTES = 64 * 1024 * 1024;

export type ReplayOptions = {
  sessionJsonlPath: string;
  maxEvents?: number | undefined;
  maxBytes?: number | undefined;
  maxLineBytes?: number | undefined;
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

type ReplayReadState = {
  bytesRead: number;
};

type BoundedReplayLine = { kind: 'line'; line: string } | { kind: 'oversized' };

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

function normalizeLimit(value: number | undefined, fallback: number, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  return value !== undefined && Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function appendReplayLineSegment(
  lineParts: Buffer[],
  lineBytes: { value: number },
  oversized: { value: boolean },
  segment: Buffer,
  maxLineBytes: number,
): void {
  if (oversized.value || segment.length === 0) return;
  const remaining = maxLineBytes - lineBytes.value;
  if (segment.length > remaining) {
    if (remaining > 0) lineParts.push(segment.subarray(0, remaining));
    lineBytes.value = maxLineBytes;
    oversized.value = true;
    return;
  }
  lineParts.push(segment);
  lineBytes.value += segment.length;
}

function finishReplayLine(
  lineParts: Buffer[],
  lineBytes: { value: number },
  oversized: { value: boolean },
): BoundedReplayLine {
  const result: BoundedReplayLine = oversized.value
    ? { kind: 'oversized' }
    : {
        kind: 'line',
        line: Buffer.concat(lineParts, lineBytes.value).toString('utf8').replace(/\r$/, ''),
      };
  lineParts.length = 0;
  lineBytes.value = 0;
  oversized.value = false;
  return result;
}

async function* readBoundedReplayLines(
  opts: ReplayOptions,
  state: ReplayReadState,
): AsyncGenerator<BoundedReplayLine> {
  if (!existsSync(opts.sessionJsonlPath)) return;

  const maxLineBytes = normalizeLimit(opts.maxLineBytes, CALL_SESSION_LOG_MAX_PUBLIC_PAYLOAD_BYTES);
  const maxBytes = normalizeLimit(opts.maxBytes, REPLAY_MAX_BYTES, true);
  if (maxBytes === 0) {
    return;
  }

  const lineParts: Buffer[] = [];
  const lineBytes = { value: 0 };
  const oversized = { value: false };
  const stream = createReadStream(opts.sessionJsonlPath);

  try {
    for await (const chunk of stream) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      let offset = 0;
      while (offset < bytes.length) {
        if (state.bytesRead >= maxBytes) {
          return;
        }

        const newlineIndex = bytes.indexOf(0x0a, offset);
        const segmentEnd = newlineIndex === -1 ? bytes.length : newlineIndex;
        const segment = bytes.subarray(offset, segmentEnd);
        const remainingBudget = maxBytes - state.bytesRead;
        if (segment.length > remainingBudget) {
          appendReplayLineSegment(
            lineParts,
            lineBytes,
            oversized,
            segment.subarray(0, remainingBudget),
            maxLineBytes,
          );
          state.bytesRead = maxBytes;
          return;
        }

        appendReplayLineSegment(lineParts, lineBytes, oversized, segment, maxLineBytes);
        state.bytesRead += segment.length;
        if (newlineIndex === -1) break;

        if (state.bytesRead >= maxBytes) return;
        state.bytesRead += 1;
        yield finishReplayLine(lineParts, lineBytes, oversized);
        if (state.bytesRead >= maxBytes) return;
        offset = newlineIndex + 1;
      }
    }

    if (lineBytes.value > 0 || oversized.value) {
      yield finishReplayLine(lineParts, lineBytes, oversized);
    }
  } finally {
    stream.destroy();
  }
}

export async function* streamReplayEvents(opts: ReplayOptions): AsyncGenerator<EngineEvent> {
  yield* streamReplayEventsWithDiagnostics(opts, createReplayDiagnostics());
}

async function* streamReplayEventsWithDiagnostics(
  opts: ReplayOptions,
  diagnostics: ReplayDiagnostics,
): AsyncGenerator<EngineEvent> {
  const maxEvents = normalizeLimit(opts.maxEvents, REPLAY_MAX_EVENTS, true);
  const state: ReplayReadState = { bytesRead: 0 };
  if (maxEvents === 0) return;

  for await (const boundedLine of readBoundedReplayLines(opts, state)) {
    diagnostics.totalLines += 1;
    if (boundedLine.kind === 'oversized') {
      diagnostics.skippedOversized += 1;
      continue;
    }
    const result = parseJsonlLine(boundedLine.line);
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
    if (diagnostics.replayedEvents >= maxEvents) return;
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
