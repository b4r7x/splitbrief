import type { Session } from '../../../src/core/schemas/session.js';
import { makeSummary } from './summary.js';

type SessionOverrides = Partial<Omit<Session, 'status' | 'summary'>> & {
  status?: Session['status'];
  summary?: Session['summary'];
};

export function makeSession(overrides?: SessionOverrides): Session {
  const status = overrides?.status ?? ('interrupted' as const);
  const base = {
    id: 'sess-1',
    feature: 'test feature',
    startedAt: 1_700_000_000,
    completedAt: null,
    stateVersion: 1,
    stateFile: null,
    ...overrides,
  };
  if (status === 'complete') {
    return { ...base, status, summary: overrides?.summary ?? makeSummary() };
  }
  return { ...base, status, summary: overrides?.summary ?? null };
}
