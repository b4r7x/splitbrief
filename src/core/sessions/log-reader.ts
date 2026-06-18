import { existsSync, createReadStream, lstatSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { parseJsonlLine } from '../../lib/fs.js';
import type {
  SessionLogEntry,
  SessionLogEventEntry,
  SessionLogMessageEntry,
  SessionLogSummaryEntry,
} from '../schemas/session-log.js';
import { SESSION_LOG_MAX_ENTRY_BYTES } from '../schemas/session-log.js';
import type { SessionRef } from '../types/session-ref.js';
import { SESSION_LOG_FILE, sessionDir } from '../paths.js';
import { SessionLogEntrySchema } from '../schemas/session-log.js';

export interface SessionLogReadDiagnostics {
  totalLines: number;
  yieldedEntries: number;
  skippedBlank: number;
  skippedMalformed: number;
  skippedInvalid: number;
  skippedOversized: number;
  skippedSymlink: number;
}

export interface SessionLogReadResult {
  entries: SessionLogEntry[];
  diagnostics: SessionLogReadDiagnostics;
}

function createSessionLogReadDiagnostics(): SessionLogReadDiagnostics {
  return {
    totalLines: 0,
    yieldedEntries: 0,
    skippedBlank: 0,
    skippedMalformed: 0,
    skippedInvalid: 0,
    skippedOversized: 0,
    skippedSymlink: 0,
  };
}

function isSymlinkedLog(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

async function* readSessionLogFile(
  file: string,
  diagnostics: SessionLogReadDiagnostics = createSessionLogReadDiagnostics(),
): AsyncIterable<SessionLogEntry> {
  if (!existsSync(file)) return;
  if (isSymlinkedLog(file)) {
    diagnostics.skippedSymlink += 1;
    return;
  }
  const stream = createReadStream(file, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    diagnostics.totalLines += 1;
    if (Buffer.byteLength(line, 'utf8') > SESSION_LOG_MAX_ENTRY_BYTES) {
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
    const parsed = SessionLogEntrySchema.safeParse(result.value);
    if (parsed.success) {
      diagnostics.yieldedEntries += 1;
      yield parsed.data;
    } else {
      diagnostics.skippedInvalid += 1;
    }
  }
}

export async function* readSessionLogFromDir(dir: string): AsyncIterable<SessionLogEntry> {
  yield* readSessionLogFile(join(dir, SESSION_LOG_FILE));
}

export async function* readSessionLog(ref: SessionRef): AsyncIterable<SessionLogEntry> {
  yield* readSessionLogFromDir(sessionDir(ref.projectDir, ref.sessionId));
}

export async function readSessionLogFromDirWithDiagnostics(
  dir: string,
): Promise<SessionLogReadResult> {
  const diagnostics = createSessionLogReadDiagnostics();
  const entries: SessionLogEntry[] = [];
  for await (const entry of readSessionLogFile(join(dir, SESSION_LOG_FILE), diagnostics)) {
    entries.push(entry);
  }
  return { entries, diagnostics };
}

export async function readSessionLogWithDiagnostics(
  ref: SessionRef,
): Promise<SessionLogReadResult> {
  return readSessionLogFromDirWithDiagnostics(sessionDir(ref.projectDir, ref.sessionId));
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

  return [summaryAsMessage(latestSummary), ...keptAfterSummary(messages, latestSummary)];
}

function keptAfterSummary(
  messages: SessionLogMessageEntry[],
  summary: SessionLogSummaryEntry,
): SessionLogMessageEntry[] {
  if (summary.summarizedCount !== undefined) return messages.slice(summary.summarizedCount);
  return messages.filter((message) => isAfterTimestamp(message.ts, summary.summarizedUpTo));
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
