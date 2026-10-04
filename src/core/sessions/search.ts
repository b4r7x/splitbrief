import type { Session } from '../schemas/session.js';
import { sessionStatusWord } from './display.js';

export function filterSession(session: Session, query: string): boolean {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);

  if (terms.length === 0) return true;

  // The row spells the stop reason, not the status, so a filter has to match both.
  const searchable = [
    session.feature,
    session.id,
    session.status,
    session.stop ?? '',
    sessionStatusWord(session),
  ]
    .join(' ')
    .toLowerCase();
  return terms.every((term) => searchable.includes(term));
}
