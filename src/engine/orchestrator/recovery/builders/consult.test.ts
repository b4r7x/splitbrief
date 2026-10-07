import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import { buildConsultBoundRecoveryIssue } from './consult.js';

const createdAt = '2026-04-28T12:00:00.000Z';

describe('buildConsultBoundRecoveryIssue', () => {
  it('offers the grant, a skip of the brief it names and the end, recommending the grant', () => {
    const issue = buildConsultBoundRecoveryIssue({
      reason: 'consult-bound-spent',
      phase: 'escalating',
      task: makeTask({ id: 'T007' }),
      lastDiagnosis: 'The brief names a file that does not exist',
      createdAt,
    });

    expect(issue.availableActions).toEqual(['continue', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('continue');
    expect(issue.seat).toBe('build');
    expect(RecoveryIssueSchema.safeParse(issue).success).toBe(true);
  });

  it('offers no skip when the spent bound names no brief', () => {
    const issue = buildConsultBoundRecoveryIssue({
      reason: 'planner-calls-spent',
      phase: 'final-review',
      lastDiagnosis: 'The review needs triage',
      createdAt,
    });

    expect(issue.availableActions).toEqual(['continue', 'end-run']);
    expect(issue.recommendedAction).toBe('continue');
    expect(issue.seat).toBe('plan');
    expect(RecoveryIssueSchema.safeParse(issue).success).toBe(true);
  });

  it('says that Continue starts from the files the last attempt left when the halt names a brief', () => {
    const lineageHalt = buildConsultBoundRecoveryIssue({
      reason: 'consult-bound-spent',
      phase: 'escalating',
      task: makeTask({ id: 'T008' }),
      lastDiagnosis: 'lint failed: src/main.ts format',
      createdAt,
    });
    const runHalt = buildConsultBoundRecoveryIssue({
      reason: 'planner-calls-spent',
      phase: 'final-review',
      lastDiagnosis: 'The review needs triage',
      createdAt,
    });

    expect(lineageHalt.details).toContain(
      "Continuing grants one more consult and four more attempts, starting from the last attempt's files.",
    );
    expect(runHalt.details).toContain('Continuing grants five more planner calls.');
  });
});
