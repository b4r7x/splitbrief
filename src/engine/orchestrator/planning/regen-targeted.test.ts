import { describe, expect, it } from 'vitest';
import { buildBriefQualityRepairComment, buildTargetedRejectionComment } from './regen-targeted.js';
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

  it('includes the user reason while preserving non-flagged tasks', () => {
    const task = makeTask({ id: 'T003', title: 'Split broad task', file: 'src/broad.ts' });

    const comment = buildTargetedRejectionComment([task], 'too broad for one worker');

    expect(comment).toContain('- T003: "Split broad task" (src/broad.ts)');
    expect(comment).toContain('User reason: too broad for one worker');
    expect(comment).toContain('Keep every other task unchanged');
  });
});

describe('buildBriefQualityRepairComment', () => {
  it('lists every blocking issue and demands per-brief tests even when another brief owns the test file', () => {
    const comment = buildBriefQualityRepairComment([
      'Task T001 has no tests',
      'Task T003 has no tests',
    ]);

    expect(comment).toContain('- Task T001 has no tests');
    expect(comment).toContain('- Task T003 has no tests');
    expect(comment).toContain('even when a different brief owns the test file');
    expect(comment).toContain('Keep the feature scope, the brief ids, and the dependency links');
  });
});
