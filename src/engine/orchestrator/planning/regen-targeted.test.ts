import { describe, expect, it } from 'vitest';
import { buildTargetedRejectionComment } from './regen-targeted.js';
import { makeTask } from '#testing/helpers/factories/task.js';

describe('buildTargetedRejectionComment', () => {
  it('returns empty string for empty array', () => {
    expect(buildTargetedRejectionComment([])).toBe('');
  });

  it('lists only the flagged tasks and instructs the planner to regenerate them', () => {
    const first = makeTask({ id: 'T001', title: 'Add auth', file: 'src/auth.ts' });
    const second = makeTask({ id: 'T002', title: 'Add logging', file: 'src/log.ts' });

    expect(buildTargetedRejectionComment([first, second])).toBe(
      [
        'The user has flagged the following tasks for regeneration:',
        '',
        '- T001: "Add auth" (src/auth.ts)',
        '- T002: "Add logging" (src/log.ts)',
        '',
        'The Current Task Briefs section lists the full existing task list. Regenerate ONLY the flagged tasks above.',
        'Keep every other task unchanged, including IDs, ordering, and dependency links.',
        'For each flagged task, keep the same goal and revise the description, scope, tests, and implementation steps to address the user feedback.',
      ].join('\n'),
    );
  });
});
