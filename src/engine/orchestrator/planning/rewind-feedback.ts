import type { PlanningPhaseOptions } from './types.js';

export function withRewindFeedback(
  feature: string,
  rewindPending: PlanningPhaseOptions['rewindPending'],
): string {
  if (rewindPending?.comment === undefined) return feature;
  return `${feature}\n\n<rewind-feedback target="${rewindPending.target}">\n${rewindPending.comment}\n</rewind-feedback>`;
}
