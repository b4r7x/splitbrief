import type { ReadinessCheck, ReadinessReport } from '../../src/core/readiness/types.js';

export const RUN = { projectDir: '/tmp/project', sessionId: '2026-01-01-fix-the-readme' };

export function reportWith(checks: ReadinessCheck[]): ReadinessReport {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    projectDir: '/tmp/project',
    status: 'ready-with-warnings',
    counts: { ok: 0, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue', label: 'Continue', reason: 'ready' },
    sections: [{ id: 'checks', title: 'Checks', checks }],
    metadata: {},
  };
}
