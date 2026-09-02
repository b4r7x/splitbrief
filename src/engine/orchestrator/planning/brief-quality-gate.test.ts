import { describe, expect, it } from 'vitest';
import { runBriefQualityGate } from './brief-quality-gate.js';
import { makeTask } from '#testing/helpers/factories/task.js';

const completeTask = {
  id: 'T001',
  tests: ['validates email format with regex'],
  implementationSteps: ['1. Add validateEmail function'],
  scope: { inBounds: ['email validation'], outOfBounds: ['UI changes'] },
  evidence: ['test coverage shows > 90%'],
};

describe('runBriefQualityGate', () => {
  it('passes a task whose only defect is a warning', () => {
    const result = runBriefQualityGate({
      tasks: [makeTask({ ...completeTask, typeDefs: '' })],
    });

    expect(result.report.issues).toEqual([
      expect.objectContaining({ code: 'missing_type_definitions', severity: 'warning' }),
    ]);
    expect(result).toMatchObject({ errorCount: 0, warningCount: 1, ok: true });
  });

  it('blocks on error issues and attributes every issue to its task', () => {
    const result = runBriefQualityGate({ tasks: [makeTask({ id: 'T001' })] });

    expect(result.report.issues.map((issue) => issue.code)).toEqual([
      'missing_scope',
      'missing_evidence',
      'missing_type_definitions',
    ]);
    expect(result.report.issues.every((issue) => issue.taskId === 'T001')).toBe(true);
    expect(result).toMatchObject({ errorCount: 2, warningCount: 1, ok: false });
  });
});
