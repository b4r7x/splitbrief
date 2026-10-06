import { describe, expect, it } from 'vitest';
import { TaskIdSchema, formatTaskId } from './task.js';

describe('TaskIdSchema', () => {
  it('requires zero-padded TNNN IDs', () => {
    expect(TaskIdSchema.safeParse('T001').success).toBe(true);
    expect(TaskIdSchema.safeParse('T1').success).toBe(false);
  });

  it('formats numeric task positions as TNNN IDs', () => {
    expect(formatTaskId(1)).toBe('T001');
  });
});
