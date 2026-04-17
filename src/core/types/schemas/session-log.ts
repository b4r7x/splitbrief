import { z } from 'zod';
import type { SessionLogEntry } from '../events.js';
import { narrowRecord } from '../../../utils/type-guards.js';

// Minimal runtime check for JSONL session log entries. Only asserts the shared
// discriminator fields that callers switch on (`kind`, plus `type`/`role`);
// full event payloads are validated elsewhere at the emit boundary. Malformed
// entries are skipped by the reader.
function isSessionLogEntry(value: unknown): value is SessionLogEntry {
  const record = narrowRecord(value);
  if (!record) return false;
  if (typeof record.ts !== 'string') return false;
  if (record.kind === 'event') {
    return typeof record.type === 'string' && typeof record.phase === 'string';
  }
  if (record.kind === 'message') {
    return (record.role === 'user' || record.role === 'assistant')
      && typeof record.text === 'string';
  }
  return false;
}

export const SessionLogEntrySchema = z.custom<SessionLogEntry>(isSessionLogEntry);
