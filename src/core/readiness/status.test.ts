import { describe, expect, it } from 'vitest';
import {
  aggregateReadinessStatus,
  countReadinessChecks,
  selectNextAction,
} from './status.js';
import type { ReadinessCheck } from './types.js';

describe('readiness status', () => {
  it('aggregates blockers before warnings', () => {
    const checks: ReadinessCheck[] = [
      { id: 'a', severity: 'warning', summary: 'warn' },
      { id: 'b', severity: 'blocker', summary: 'block' },
    ];

    const counts = countReadinessChecks(checks);

    expect(counts.warning).toBe(1);
    expect(counts.blocker).toBe(1);
    expect(aggregateReadinessStatus(counts)).toBe('blocked');
  });

  it('selects the highest-priority next action from checks', () => {
    const checks: ReadinessCheck[] = [
      { id: 'context', severity: 'warning', summary: 'small context', nextAction: 'raise-context' },
      { id: 'config', severity: 'blocker', summary: 'bad config', nextAction: 'fix-config' },
      { id: 'budget', severity: 'warning', summary: 'no budget', nextAction: 'set-budget' },
    ];

    expect(selectNextAction(checks, 'blocked')).toMatchObject({
      kind: 'fix-config',
      label: 'Fix config',
      reason: 'bad config',
    });
  });

  it('defaults to continue when only advisory checks exist', () => {
    const checks: ReadinessCheck[] = [
      { id: 'mode', severity: 'info', summary: 'mode standard' },
    ];

    expect(selectNextAction(checks, 'ready')).toMatchObject({
      kind: 'continue',
      reason: 'No readiness blockers found.',
    });
  });
});
