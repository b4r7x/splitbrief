import { describe, it, expect } from 'vitest';
import { evaluateBriefQuality, isBriefQualityReport } from './brief-quality.js';
import { makeTask } from '#testing/helpers/factories/task.js';

function makeFullTask() {
  return makeTask({
    tests: ['validates email format with regex', 'rejects empty string'],
    implementationSteps: ['1. Add validateEmail function', '2. Return null on valid'],
    typeDefs: 'function validateEmail(value: string): string | null',
    scope: { inBounds: ['email validation'], outOfBounds: ['UI changes'] },
    evidence: ['test coverage shows > 90%'],
  });
}

describe('evaluateBriefQuality — pure unit tests', () => {
  it('valid brief passes with score 1', () => {
    const report = evaluateBriefQuality([makeFullTask()]);
    expect(report.passed).toBe(true);
    expect(report.score).toBe(1);
    expect(report.issues).toHaveLength(0);
    expect(report.version).toBe(1);
  });

  it('empty task list blocks with empty_task_list error', () => {
    const report = evaluateBriefQuality([]);
    expect(report.passed).toBe(false);
    expect(report.score).toBe(0.8);
    const issue = report.issues.find(i => i.code === 'empty_task_list');
    expect(issue?.severity).toBe('error');
  });

  it('score clamps to 0 when many errors accumulate', () => {
    const task = makeTask({
      action: 'modify',
      tests: [],
      implementationSteps: [],
      description: 'Update src/api.ts and src/utils.ts with auth and database config',
    });
    const report = evaluateBriefQuality([task]);
    expect(report.score).toBe(0);
    expect(report.passed).toBe(false);
  });

  it.each([
    ['missing_validation', { tests: [] }],
    ['vague_validation', { tests: ['works correctly', 'validate'] }],
    ['missing_escalation', { description: 'Update the auth middleware to validate permissions', tests: ['rejects invalid token', 'allows valid request'], implementationSteps: ['1. Check auth header'] }],
    ['missing_evidence', { tests: ['validates email format'], implementationSteps: ['1. Add function'], typeDefs: 'function foo(): void', scope: { inBounds: ['foo'] } }],
    ['missing_code_context', { action: 'modify' as const, tests: ['returns correct result'], implementationSteps: ['1. Modify the function'] }],
    ['multi_file_task', { description: 'Update src/api.ts and also modify src/utils.ts for new helpers', tests: ['returns expected value'], implementationSteps: ['1. Edit src/api.ts', '2. Update src/utils.ts'] }],
    ['missing_implementation_steps', { implementationSteps: [] }],
    ['missing_scope', { tests: ['validates email format with regex', 'rejects empty string'], implementationSteps: ['1. Add validateEmail function', '2. Return null on valid'], typeDefs: 'function validateEmail(value: string): string | null', scope: undefined, evidence: ['test coverage shows > 90%'] }],
  ] as [string, Record<string, unknown>][])('blocks on %s', (code, overrides) => {
    const task = makeTask(overrides);
    const report = evaluateBriefQuality([task]);
    expect(report.passed).toBe(false);
    const issue = report.issues.find(i => i.code === code);
    expect(issue?.severity).toBe('error');
  });

  it.each([
    ['same file path twice does not flag multi_file_task', {
      description: 'Update src/api.ts and keep src/api.ts aligned with the new helper',
      tests: ['returns expected value'],
      implementationSteps: ['1. Edit src/api.ts', '2. Keep src/api.ts in sync'],
      typeDefs: 'function updateApi(): void',
      scope: { inBounds: ['src/api.ts'], outOfBounds: ['src/utils.ts'] },
      evidence: ['src/api.ts behavior remains covered'],
    }, 'multi_file_task'],
    ['risk words in title but not description do not trigger missing_escalation', {
      title: 'Add auth middleware',
      description: 'Adds a middleware layer with basic routing logic',
      tests: ['routes correctly'],
      implementationSteps: ['1. Add middleware'],
      typeDefs: 'type Middleware = unknown',
      scope: { inBounds: ['middleware routing'], outOfBounds: ['auth token validation'] },
      evidence: ['routing middleware test passes'],
    }, 'missing_escalation'],
    ['risky task with escalation provided does not flag missing_escalation', {
      description: 'Update the auth middleware to validate permissions',
      tests: ['rejects invalid token'],
      implementationSteps: ['1. Check header'],
      typeDefs: 'type AuthMiddleware = unknown',
      scope: { inBounds: ['auth middleware'], outOfBounds: ['database schema'] },
      evidence: ['invalid token test fails before and passes after'],
      escalation: ['Stop if token format is unexpected'],
    }, 'missing_escalation'],
    ['non-vague tests pass vague_validation check', {
      tests: ['passes tsc', 'validates schema'],
      typeDefs: 'type SchemaResult = boolean',
      scope: { inBounds: ['schema validation'], outOfBounds: ['runtime behavior'] },
      evidence: ['schema validation test passes'],
    }, 'vague_validation'],
  ] as [string, Record<string, unknown>, string][])('%s', (_label, overrides, absentCode) => {
    const task = makeTask(overrides);
    const report = evaluateBriefQuality([task]);
    expect(report.issues.find(i => i.code === absentCode)).toBeUndefined();
  });
});

describe('isBriefQualityReport', () => {
  it('accepts a valid persisted report', () => {
    expect(isBriefQualityReport({
      version: 1,
      passed: false,
      score: 0.8,
      issues: [{
        taskId: 'T001',
        severity: 'error',
        code: 'missing_scope',
        message: 'Task T001 has no scope definition',
      }],
    })).toBe(true);
  });

  it('rejects invalid report shapes', () => {
    expect(isBriefQualityReport({
      version: 1,
      passed: true,
      score: '1.00',
      issues: [],
    })).toBe(false);
    expect(isBriefQualityReport({
      version: 1,
      passed: true,
      score: 1,
      issues: [{ taskId: 'T001', severity: 'error', code: 'unknown', message: 'bad' }],
    })).toBe(false);
  });
});
