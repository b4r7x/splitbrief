import { describe, it, expect } from 'vitest';
import {
  RECOVERY_ACTIONS,
  WorkflowModeSchema,
  WORKFLOW_MODES,
  normalizeLegacyMode,
} from './enums.js';

describe('WORKFLOW_MODES', () => {
  it('does not include legacy "full"', () => {
    expect((WORKFLOW_MODES as readonly string[]).includes('full')).toBe(false);
  });
  it('WorkflowModeSchema rejects "full"', () => {
    expect(WorkflowModeSchema.safeParse('full').success).toBe(false);
  });
});

describe('normalizeLegacyMode', () => {
  it.each([
    ['instant', 'instant'],
    ['quick', 'quick'],
    ['standard', 'standard'],
    ['speckit', 'speckit'],
    ['full', 'speckit'],
  ])('normalizes "%s" → "%s"', (input, expected) => {
    expect(normalizeLegacyMode(input)).toBe(expected);
  });
  it('returns null for unknown values', () => {
    expect(normalizeLegacyMode('bogus')).toBeNull();
    expect(normalizeLegacyMode('')).toBeNull();
  });
});

describe('RECOVERY_ACTIONS', () => {
  it('includes all v1 recovery actions', () => {
    expect(RECOVERY_ACTIONS).toEqual([
      'retry-same-worker',
      'route-bigger-worker',
      'planner-split-rebase',
      'continue',
      'skip-current-task',
      'pause-run',
      'abort-workflow',
    ]);
  });
});
