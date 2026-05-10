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

    expect(buildTargetedRejectionComment([first, second])).toBe([
      'The user has flagged the following tasks for regeneration:',
      '',
      '- T001: "Add auth" (src/auth.ts)',
      '- T002: "Add logging" (src/log.ts)',
      '',
      'Please regenerate ONLY these tasks. Keep all other tasks unchanged.',
      'Produce improved versions that address the same goals but with better implementation approach.',
    ].join('\n'));
  });
});
