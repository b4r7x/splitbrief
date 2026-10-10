import { SessionSchema, type Session } from '../schemas/session.js';

export type ParsedPersistedSession =
  | { status: 'ok'; session: Session }
  | { status: 'invalid'; error: string };

export function parsePersistedSession(value: unknown): ParsedPersistedSession {
  const result = SessionSchema.safeParse(value);
  if (!result.success) return { status: 'invalid', error: result.error.message };
  return { status: 'ok', session: result.data };
}
