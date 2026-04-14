import { existsSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';
import type { SessionLogEntry, SessionLogEventEntry, SessionLogMessageEntry } from '../types/index.js';
import { SESSION_LOG_FILE, sessionDir } from '../paths.js';
import { narrowRecord } from '../../utils/type-guards.js';

export async function* readSessionLog(projectDir: string, sessionId: string): AsyncIterable<SessionLogEntry> {
  const file = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
  if (!existsSync(file)) return;
  const stream = createReadStream(file, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = narrowRecord(JSON.parse(line));
      if (parsed && (parsed.kind === 'event' || parsed.kind === 'message')) {
        yield parsed as SessionLogEntry;
      }
    } catch {
      // skip corrupt lines
    }
  }
}

export async function* readMessages(projectDir: string, sessionId: string): AsyncIterable<SessionLogMessageEntry> {
  for await (const entry of readSessionLog(projectDir, sessionId)) {
    if (entry.kind === 'message') yield entry;
  }
}

export async function* readEvents(projectDir: string, sessionId: string): AsyncIterable<SessionLogEventEntry> {
  for await (const entry of readSessionLog(projectDir, sessionId)) {
    if (entry.kind === 'event') yield entry;
  }
}
