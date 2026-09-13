import { describe, expect, it } from 'vitest';
import { TaskIdSchema, formatTaskId, taskFiles } from './task.js';

describe('TaskIdSchema', () => {
  it('requires zero-padded TNNN IDs', () => {
    expect(TaskIdSchema.safeParse('T001').success).toBe(true);
    expect(TaskIdSchema.safeParse('T1').success).toBe(false);
  });

  it('formats numeric task positions as TNNN IDs', () => {
    expect(formatTaskId(1)).toBe('T001');
  });
});

describe('taskFiles', () => {
  it('files defaults to [file]', () => {
    expect(taskFiles({ file: 'src/a.ts' })).toEqual(['src/a.ts']);
    expect(taskFiles({ file: 'src/a.ts', files: [] })).toEqual(['src/a.ts']);
  });

  it('returns the declared list when present', () => {
    expect(taskFiles({ file: 'src/a.ts', files: ['src/a.ts', 'src/a.test.ts'] })).toEqual([
      'src/a.ts',
      'src/a.test.ts',
    ]);
  });
});
