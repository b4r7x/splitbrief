import { describe, it, expect } from 'vitest';
import {
  RecoveryActionSchema,
  RECOVERY_ACTIONS,
  RECOVERY_REASONS,
  WorkflowModeSchema,
  WORKFLOW_MODES,
  normalizeLegacyMode,
} from './enums.js';

describe('WORKFLOW_MODES', () => {
  it('includes all four canonical modes', () => {
    expect(WORKFLOW_MODES).toEqual(['instant', 'quick', 'standard', 'speckit']);
  });
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

  it('RecoveryActionSchema accepts each v1 recovery action', () => {
    for (const action of RECOVERY_ACTIONS) {
      expect(RecoveryActionSchema.safeParse(action).success).toBe(true);
    }
  });
});

describe('RECOVERY_REASONS', () => {
  it('includes all v1 recovery reasons', () => {
    expect(RECOVERY_REASONS).toEqual([
      'implementation-error',
      'validation-failed',
      'retry-exhausted',
      'context-overflow',
      'user-edit-conflict',
      'approval-promotion-conflict',
      'budget-paused',
      'budget-exceeded',
      'dependency-blocked',
    ]);
  });
});
