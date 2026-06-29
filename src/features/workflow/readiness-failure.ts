import type { ReadinessReport } from '../../core/readiness/types.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { nowIso } from '../../utils/format-time.js';

export function buildReadinessFailureReport(projectDir: string, err: unknown): ReadinessReport {
  const message = toErrorMessage(err);
  return {
    generatedAt: nowIso(),
    projectDir,
    status: 'blocked',
    counts: { ok: 0, info: 0, warning: 0, blocker: 1 },
    nextAction: {
      kind: 'exit',
      label: 'fix and rerun',
      reason: 'readiness could not be collected',
    },
    sections: [
      {
        id: 'readiness',
        title: 'readiness',
        checks: [
          {
            id: 'readiness.collection-failed',
            severity: 'blocker',
            summary: 'collection failed before start',
            details: [message],
            nextAction: 'exit',
          },
        ],
      },
    ],
    metadata: {},
  };
}
