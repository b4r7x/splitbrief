import type { ReadinessReport } from '../../../src/core/readiness/types.js';

/**
 * A blocked preparation is how a broken e2e run shows up first — cassette drift
 * in replay, a runner the live tier cannot reach. Naming the blockers here is
 * the difference between "ended with 'blocked'" and a diagnosis.
 */
export function blockerLines(report: ReadinessReport): string[] {
  return report.sections.flatMap((section) =>
    section.checks
      .filter((check) => check.severity === 'blocker')
      .map((check) => `  ${check.id}: ${[check.summary, ...(check.details ?? [])].join(' ')}`),
  );
}
