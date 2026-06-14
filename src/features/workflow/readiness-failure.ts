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
      label: 'Resolve readiness failure',
      reason: 'Readiness collection failed before the workflow could start.',
    },
    sections: [
      {
        id: 'readiness',
        title: 'Readiness',
        checks: [
          {
            id: 'readiness.collection-failed',
            severity: 'blocker',
            summary: 'Readiness check failed',
            details: [message],
            nextAction: 'exit',
          },
        ],
      },
    ],
    metadata: {},
  };
}
