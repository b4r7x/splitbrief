import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../../engine/events/types.js';
import { joinsCheckList } from './check-list-spacing.js';

describe('joinsCheckList', () => {
  it.each([
    ['review_checks', 'full_suite'],
    ['full_suite', 'full_suite'],
  ] as const)('joins %s followed by %s', (previous, next) => {
    expect(joinsCheckList(previous, next)).toBe(true);
  });

  const boundaries: (EngineEvent['type'] | undefined)[] = [
    'user_message',
    'planner_text',
    'runner_call_activity',
    'recovery_action_selected',
    'task_started',
    'validate',
    'drift_report',
    undefined,
  ];

  it.each(boundaries)('does not join a check list after %s', (previous) => {
    expect(joinsCheckList(previous, 'full_suite')).toBe(false);
    expect(joinsCheckList(previous, 'drift_report')).toBe(false);
  });

  it.each([...boundaries, 'review_checks'] satisfies (EngineEvent['type'] | undefined)[])(
    'does not join a boundary %s after checks',
    (next) => {
      expect(joinsCheckList('review_checks', next)).toBe(false);
      expect(joinsCheckList('full_suite', next)).toBe(false);
    },
  );
});
