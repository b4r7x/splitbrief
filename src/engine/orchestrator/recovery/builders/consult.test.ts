import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import { buildNoProgressRecoveryIssue } from './consult.js';

const createdAt = '2026-04-28T12:00:00.000Z';

describe('buildNoProgressRecoveryIssue', () => {
  it('offers Continue, a skip of the brief and the end, recommending Continue', () => {
    const issue = buildNoProgressRecoveryIssue({
      phase: 'escalating',
      task: makeTask({ id: 'T007' }),
      stop: 'no-progress',
      failure: [{ source: 'check V1', keys: ['src/main.ts: TS2322'] }],
      answers: 3,
      lastDiagnosis: 'The brief names a file that does not exist',
      createdAt,
    });

    expect(issue.reason).toBe('no-progress');
    expect(issue.message).toBe('T007 is stuck on the same failure');
    expect(issue.availableActions).toEqual(['continue', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('continue');
    expect(issue.seat).toBe('build');
    expect(RecoveryIssueSchema.safeParse(issue).success).toBe(true);
  });

  it('names the failure, the last diagnosis and where Continue starts from', () => {
    const issue = buildNoProgressRecoveryIssue({
      phase: 'escalating',
      task: makeTask({ id: 'T008' }),
      stop: 'unconverged',
      failure: [
        { source: 'check V1', keys: ['a', 'b', 'c', 'd', 'e'] },
        { source: 'check V2', keys: [] },
      ],
      answers: 10,
      lastDiagnosis: 'lint failed: src/main.ts format',
      createdAt,
    });

    expect(issue.message).toBe('T008 did not settle after 10 planner answers');
    expect(issue.details).toEqual([
      'Failure: check V1: a, b, c (+2 more); check V2',
      'Last diagnosis: lint failed: src/main.ts format',
      "Continuing asks the planner again, starting from the last attempt's files.",
    ]);
  });
});
