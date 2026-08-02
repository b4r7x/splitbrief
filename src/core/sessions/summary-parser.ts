import { SessionSchema, type Session } from '../schemas/session.js';
import { SummarySchema, type Summary } from '../schemas/summary.js';

export type ParsedPersistedSession =
  | { status: 'ok'; session: Session }
  | { status: 'invalid'; error: string };

export type ParsedPersistedSummary =
  | { status: 'ok'; summary: Summary }
  | { status: 'invalid'; error: string };

export function parsePersistedSession(value: unknown): ParsedPersistedSession {
  const result = SessionSchema.safeParse(value);
  if (!result.success) return { status: 'invalid', error: result.error.message };
  return { status: 'ok', session: result.data };
}

export function parsePersistedSummary(value: unknown): ParsedPersistedSummary {
  const result = SummarySchema.safeParse(value);
  if (!result.success) return { status: 'invalid', error: result.error.message };
  return { status: 'ok', summary: result.data };
}
