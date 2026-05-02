import { describe, expect, it } from 'vitest';
import { buildTargetedRejectionComment } from './regen-targeted.js';
import { makeTask } from '#testing/helpers/factories/task.js';

describe('buildTargetedRejectionComment', () => {
  it('returns empty string for empty array', () => {
    expect(buildTargetedRejectionComment([])).toBe('');
  });

  it('returns correct format for a single task', () => {
    const task = makeTask({ id: 'T001', title: 'Add auth', file: 'src/auth.ts' });
    const result = buildTargetedRejectionComment([task]);

    expect(result).toContain('T001');
    expect(result).toContain('Add auth');
    expect(result).toContain('src/auth.ts');
    expect(result).toContain('flagged the following tasks for regeneration');
    expect(result).toContain('regenerate ONLY these tasks');
  });

  it('returns correct format for multiple tasks', () => {
    const first = makeTask({ id: 'T001', title: 'Add auth', file: 'src/auth.ts' });
    const second = makeTask({ id: 'T002', title: 'Add logging', file: 'src/log.ts' });
    const result = buildTargetedRejectionComment([first, second]);

    expect(result).toContain('T001');
    expect(result).toContain('Add auth');
    expect(result).toContain('src/auth.ts');
    expect(result).toContain('T002');
    expect(result).toContain('Add logging');
    expect(result).toContain('src/log.ts');
  });

  it('includes task ID, title, and file in each line', () => {
    const task = makeTask({ id: 'T003', title: 'Refactor utils', file: 'src/utils.ts' });
    const result = buildTargetedRejectionComment([task]);
    const lines = result.split('\n');
    const taskLine = lines.find(l => l.startsWith('- '));

    expect(taskLine).toContain('T003');
    expect(taskLine).toContain('"Refactor utils"');
    expect(taskLine).toContain('src/utils.ts');
  });
});