import type { EngineEvent } from '../../../engine/events/types.js';

export function joinsCheckList(
  previous: EngineEvent['type'] | undefined,
  next: EngineEvent['type'] | undefined,
): boolean {
  return (
    (previous === 'review_checks' || previous === 'full_suite') &&
    (next === 'full_suite' || next === 'drift_report')
  );
}
