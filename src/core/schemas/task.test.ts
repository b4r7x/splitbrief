import { describe, expect, it } from 'vitest';
import { CheckResultSchema, TaskIdSchema, formatTaskId } from './task.js';

describe('TaskIdSchema', () => {
  it('requires zero-padded TNNN IDs', () => {
    expect(TaskIdSchema.safeParse('T001').success).toBe(true);
    expect(TaskIdSchema.safeParse('T1').success).toBe(false);
  });

  it('formats numeric task positions as TNNN IDs', () => {
    expect(formatTaskId(1)).toBe('T001');
  });
});

describe('CheckResultSchema', () => {
  it('keeps a check that never ran apart from a pass and a failure', () => {
    expect(CheckResultSchema.parse({ id: 'K2', status: 'refused' })).toEqual({
      id: 'K2',
      status: 'refused',
    });
  });

  it('reads the passed flag an older run saved as the status of a check that ran', () => {
    expect(CheckResultSchema.parse({ id: 'K1', passed: true })).toEqual({
      id: 'K1',
      status: 'pass',
    });
    expect(CheckResultSchema.parse({ id: 'K2', passed: false })).toEqual({
      id: 'K2',
      status: 'fail',
    });
  });
});
