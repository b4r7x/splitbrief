import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SECURE_FILE_MODE } from '../../lib/fs.js';
import { SESSION_LOG_FILE } from '../paths.js';
import type { ResolvedCompactionFormat, StructuredSummary } from '../schemas/compaction.js';
import type { SessionLogEntry, SessionLogMessageEntry, SessionLogSummaryEntry } from '../schemas/session-log.js';
import { findLatestSummary, isAfterTimestamp, readSessionLogFromDir } from './log-reader.js';

const DEFAULT_KEEP_RECENT_COUNT = 10;

export type TranscriptCompactionPlanner = {
  summarize: (msgs: Array<{ role: string; text: string }>) => Promise<string>;
  summarizeStructured?: (
    msgs: Array<{ role: string; text: string }>,
    previousSummary?: StructuredSummary,
  ) => Promise<{ text: string; structured: StructuredSummary | null }>;
};

export type TranscriptCompactionResult = {
  summary: string;
  entriesRemoved: number;
  structured?: StructuredSummary | null;
};

export type CompactionOptions = {
  sessionDir: string;
  planner: TranscriptCompactionPlanner;
  keepRecentCount?: number;
  format: ResolvedCompactionFormat;
  onFallback?: (text: string) => void | Promise<void>;
};

export async function compactTranscript(
  opts: CompactionOptions,
): Promise<TranscriptCompactionResult> {
  const log = await readLogCompactionState(opts.sessionDir);
  const previousStructured = log.latestSummary?.structured;
  const messages = messagesToSummarize(log, opts.format, previousStructured);
  const summarizeCount = messages.length - normalizedKeepCount(opts.keepRecentCount ?? DEFAULT_KEEP_RECENT_COUNT);
  if (summarizeCount <= 0) return { summary: '', entriesRemoved: 0 };

  const summarizedMessages = messages.slice(0, summarizeCount);
  const summaryInput = summarizedMessages.map(({ role, text }) => ({ role, text }));
  const { summary, structured } = await summarizeMessages(opts, previousStructured, summaryInput);
  const summarizedUpTo = summarizedMessages.at(-1)?.ts;
  if (summarizedUpTo === undefined) return { summary: '', entriesRemoved: 0 };

  await appendSummary(opts.sessionDir, {
    kind: 'summary',
    ts: String(Date.now()),
    text: summary,
    summarizedUpTo,
    ...(structured ? { structured } : {}),
  });

  if (opts.format === 'structured') {
    return { summary, entriesRemoved: summarizedMessages.length, structured };
  }
  return { summary, entriesRemoved: summarizedMessages.length };
}

type LogCompactionState = {
  messages: SessionLogMessageEntry[];
  latestSummary: SessionLogSummaryEntry | null;
};

async function readLogCompactionState(sessionDir: string): Promise<LogCompactionState> {
  const entries: SessionLogEntry[] = [];
  for await (const entry of readSessionLogFromDir(sessionDir)) {
    entries.push(entry);
  }
  return {
    messages: entries.filter(entry => entry.kind === 'message'),
    latestSummary: findLatestSummary(entries),
  };
}

function messagesToSummarize(
  log: LogCompactionState,
  format: ResolvedCompactionFormat,
  previousStructured: StructuredSummary | undefined,
): SessionLogMessageEntry[] {
  if (format !== 'structured' || !previousStructured || !log.latestSummary) return log.messages;
  return log.messages.filter(message => isAfterTimestamp(message.ts, log.latestSummary?.summarizedUpTo ?? ''));
}

function normalizedKeepCount(keepRecentCount: number): number {
  if (!Number.isFinite(keepRecentCount)) return DEFAULT_KEEP_RECENT_COUNT;
  return Math.max(0, Math.trunc(keepRecentCount));
}

async function summarizeMessages(
  opts: CompactionOptions,
  previousStructured: StructuredSummary | undefined,
  messages: Array<{ role: string; text: string }>,
): Promise<{ summary: string; structured: StructuredSummary | null }> {
  if (opts.format === 'structured' && opts.planner.summarizeStructured) {
    const result = await opts.planner.summarizeStructured(messages, previousStructured);
    if (!result.structured) await opts.onFallback?.(result.text);
    return {
      summary: result.structured ? JSON.stringify(result.structured) : result.text,
      structured: result.structured,
    };
  }

  return {
    summary: await opts.planner.summarize(messages),
    structured: null,
  };
}

async function appendSummary(sessionDir: string, entry: SessionLogSummaryEntry): Promise<void> {
  await appendFile(join(sessionDir, SESSION_LOG_FILE), `${JSON.stringify(entry)}\n`, { mode: SECURE_FILE_MODE });
}
