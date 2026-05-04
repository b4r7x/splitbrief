import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SECURE_FILE_MODE } from '../../lib/fs.js';
import { SESSION_LOG_FILE } from '../paths.js';
import type { SessionLogMessageEntry, SessionLogSummaryEntry } from '../schemas/session-log.js';
import { readSessionLogFromDir } from './log-reader.js';

const DEFAULT_KEEP_RECENT_COUNT = 10;

export type TranscriptCompactionPlanner = {
  summarize: (msgs: Array<{ role: string; text: string }>) => Promise<string>;
};

export type TranscriptCompactionResult = {
  summary: string;
  entriesRemoved: number;
};

export async function compactTranscript(
  sessionDir: string,
  planner: TranscriptCompactionPlanner,
  keepRecentCount = DEFAULT_KEEP_RECENT_COUNT,
): Promise<TranscriptCompactionResult> {
  const messages = await readLogMessages(sessionDir);
  const summarizeCount = messages.length - normalizedKeepCount(keepRecentCount);
  if (summarizeCount <= 0) return { summary: '', entriesRemoved: 0 };

  const summarizedMessages = messages.slice(0, summarizeCount);
  const summary = await planner.summarize(summarizedMessages.map(({ role, text }) => ({ role, text })));
  const summarizedUpTo = summarizedMessages.at(-1)?.ts;
  if (summarizedUpTo === undefined) return { summary: '', entriesRemoved: 0 };

  await appendSummary(sessionDir, {
    kind: 'summary',
    ts: String(Date.now()),
    text: summary,
    summarizedUpTo,
  });

  return { summary, entriesRemoved: summarizedMessages.length };
}

async function readLogMessages(sessionDir: string): Promise<SessionLogMessageEntry[]> {
  const messages: SessionLogMessageEntry[] = [];
  for await (const entry of readSessionLogFromDir(sessionDir)) {
    if (entry.kind === 'message') messages.push(entry);
  }
  return messages;
}

function normalizedKeepCount(keepRecentCount: number): number {
  if (!Number.isFinite(keepRecentCount)) return DEFAULT_KEEP_RECENT_COUNT;
  return Math.max(0, Math.trunc(keepRecentCount));
}

async function appendSummary(sessionDir: string, entry: SessionLogSummaryEntry): Promise<void> {
  await appendFile(join(sessionDir, SESSION_LOG_FILE), `${JSON.stringify(entry)}\n`, { mode: SECURE_FILE_MODE });
}
