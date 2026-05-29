import { existsSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';
import type {
  SessionLogEntry,
  SessionLogEventEntry,
  SessionLogMessageEntry,
  SessionLogSummaryEntry,
} from '../schemas/session-log.js';
import type { SessionRef } from '../types/session-ref.js';
import { SESSION_LOG_FILE, sessionDir } from '../paths.js';
import { SessionLogEntrySchema } from '../schemas/session-log.js';

async function* readSessionLogFile(file: string): AsyncIterable<SessionLogEntry> {
  if (!existsSync(file)) return;
  const stream = createReadStream(file, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = SessionLogEntrySchema.safeParse(raw);
    if (parsed.success) yield parsed.data;
  }
}

export async function* readSessionLogFromDir(dir: string): AsyncIterable<SessionLogEntry> {
  yield* readSessionLogFile(join(dir, SESSION_LOG_FILE));
}

export async function* readSessionLog(ref: SessionRef): AsyncIterable<SessionLogEntry> {
  yield* readSessionLogFromDir(sessionDir(ref.projectDir, ref.sessionId));
}

export async function* readMessages(ref: SessionRef): AsyncIterable<SessionLogMessageEntry> {
  for await (const entry of readSessionLog(ref)) {
    if (entry.kind === 'message') yield entry;
  }
}

export async function* readEvents(ref: SessionRef): AsyncIterable<SessionLogEventEntry> {
  for await (const entry of readSessionLog(ref)) {
    if (entry.kind === 'event') yield entry;
  }
}

export async function readCompactedMessages(dir: string): Promise<SessionLogMessageEntry[]> {
  const entries: SessionLogEntry[] = [];
  for await (const entry of readSessionLogFromDir(dir)) entries.push(entry);

  const latestSummary = findLatestSummary(entries);
  const messages = entries.filter((entry) => entry.kind === 'message');
  if (!latestSummary) return messages;

  return [
    summaryAsMessage(latestSummary),
    ...messages.filter((message) => isAfterTimestamp(message.ts, latestSummary.summarizedUpTo)),
  ];
}

export function findLatestSummary(entries: SessionLogEntry[]): SessionLogSummaryEntry | null {
  let latest: SessionLogSummaryEntry | null = null;
  for (const entry of entries) {
    if (entry.kind === 'summary') latest = entry;
  }
  return latest;
}

function summaryAsMessage(summary: SessionLogSummaryEntry): SessionLogMessageEntry {
  return {
    kind: 'message',
    ts: summary.ts,
    role: 'user',
    text: summary.structured ? JSON.stringify(summary.structured) : summary.text,
  };
}

export function isAfterTimestamp(timestamp: string, boundary: string): boolean {
  const left = timestampValue(timestamp);
  const right = timestampValue(boundary);
  if (left !== null && right !== null) return left > right;
  return timestamp > boundary;
}

function timestampValue(timestamp: string): number | null {
  const numeric = Number(timestamp);
  if (timestamp.trim() !== '' && Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}
