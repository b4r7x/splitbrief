import type { Session } from '../schemas/session.js';

export function filterSession(session: Session, query: string): boolean {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);

  if (terms.length === 0) return true;

  const searchable = [session.feature, session.id, session.status].join(' ').toLowerCase();
  return terms.every((term) => searchable.includes(term));
}
