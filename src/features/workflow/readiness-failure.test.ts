import { describe, expect, it } from 'vitest';
import { buildReadinessFailureReport } from './readiness-failure.js';

describe('buildReadinessFailureReport', () => {
  it('turns readiness collection errors into a blocked report', () => {
    const report = buildReadinessFailureReport('/repo', new Error('config could not be read'));

    expect(report.status).toBe('blocked');
    expect(report.counts.blocker).toBe(1);
    expect(report.nextAction.kind).toBe('exit');
    expect(report.nextAction.label).toBe('fix and rerun');
    expect(report.nextAction.reason).toBe('readiness could not be collected');
    expect(report.sections[0]?.checks[0]).toMatchObject({
      id: 'readiness.collection-failed',
      severity: 'blocker',
      summary: 'collection failed before start',
      details: ['config could not be read'],
    });
  });
});
