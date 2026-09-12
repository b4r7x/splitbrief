import {
  CATALOG_SUGGESTION_MEMBERSHIP,
  type ResolvedModelMembership,
} from '../../../engine/providers/model/catalog.js';
import type { ModelOption } from './recency.js';

const MEMBERSHIP_RANK = {
  confirmed: 0,
  stale: 1,
  [CATALOG_SUGGESTION_MEMBERSHIP]: 2,
  'bundled-suggestion': 3,
  custom: 4,
} as const satisfies Record<ResolvedModelMembership, number>;

/** A merged row states its strongest member's enumeration truth. */
export function bestMembership(rows: readonly ModelOption[]): ResolvedModelMembership | undefined {
  let best: ResolvedModelMembership | undefined;
  for (const row of rows) {
    if (row.membership === undefined) continue;
    if (best === undefined || MEMBERSHIP_RANK[row.membership] < MEMBERSHIP_RANK[best]) {
      best = row.membership;
    }
  }
  return best;
}
