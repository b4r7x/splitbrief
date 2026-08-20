import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { briefErrorMessages, evaluateBriefQuality, isBriefQualityReport } from './brief-quality.js';
import { parseTasks } from './tasks/parse.js';
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
    const issue = report.issues.find((i) => i.code === 'empty_task_list');
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
    [
      'missing_escalation',
      {
        description: 'Update the auth middleware to validate permissions',
        tests: ['rejects invalid token', 'allows valid request'],
        implementationSteps: ['1. Check auth header'],
      },
    ],
    [
      'missing_evidence',
      {
        tests: ['validates email format'],
        implementationSteps: ['1. Add function'],
        typeDefs: 'function foo(): void',
        scope: { inBounds: ['foo'] },
      },
    ],
    [
      'missing_code_context',
      {
        action: 'modify' as const,
        tests: ['returns correct result'],
        implementationSteps: ['1. Modify the function'],
      },
    ],
    [
      'multi_file_task',
      {
        description: 'Update src/api.ts and also modify src/utils.ts for new helpers',
        tests: ['returns expected value'],
        implementationSteps: ['1. Edit src/api.ts', '2. Update src/utils.ts'],
      },
    ],
    ['missing_implementation_steps', { implementationSteps: [] }],
    [
      'missing_scope',
      {
        tests: ['validates email format with regex', 'rejects empty string'],
        implementationSteps: ['1. Add validateEmail function', '2. Return null on valid'],
        typeDefs: 'function validateEmail(value: string): string | null',
        scope: undefined,
        evidence: ['test coverage shows > 90%'],
      },
    ],
  ] as [string, Record<string, unknown>][])('blocks on %s', (code, overrides) => {
    const task = makeTask(overrides);
    const report = evaluateBriefQuality([task]);
    expect(report.passed).toBe(false);
    const issue = report.issues.find((i) => i.code === code);
    expect(issue?.severity).toBe('error');
  });

  it('points missing evidence to the editable Evidence field and clears when evidence is added', () => {
    const missing = evaluateBriefQuality([
      makeTask({
        tests: ['validates email format'],
        implementationSteps: ['1. Add function'],
        typeDefs: 'function foo(): void',
        scope: { inBounds: ['foo'] },
      }),
    ]);
    const issue = missing.issues.find((item) => item.code === 'missing_evidence');
    expect(issue?.message).toContain('Evidence field');

    const fixed = evaluateBriefQuality([
      makeTask({
        tests: ['validates email format'],
        implementationSteps: ['1. Add function'],
        typeDefs: 'function foo(): void',
        scope: { inBounds: ['foo'] },
        evidence: ['validation output is saved'],
      }),
    ]);
    expect(fixed.issues.find((item) => item.code === 'missing_evidence')).toBeUndefined();
  });

  it.each([
    [
      'same file path twice does not flag multi_file_task',
      {
        description: 'Update src/api.ts and keep src/api.ts aligned with the new helper',
        tests: ['returns expected value'],
        implementationSteps: ['1. Edit src/api.ts', '2. Keep src/api.ts in sync'],
        typeDefs: 'function updateApi(): void',
        scope: { inBounds: ['src/api.ts'], outOfBounds: ['src/utils.ts'] },
        evidence: ['src/api.ts behavior remains covered'],
      },
      'multi_file_task',
    ],
    [
      'risk words in title but not description do not trigger missing_escalation',
      {
        title: 'Add auth middleware',
        description: 'Adds a middleware layer with basic routing logic',
        tests: ['routes correctly'],
        implementationSteps: ['1. Add middleware'],
        typeDefs: 'type Middleware = unknown',
        scope: { inBounds: ['middleware routing'], outOfBounds: ['auth token validation'] },
        evidence: ['routing middleware test passes'],
      },
      'missing_escalation',
    ],
    [
      'risky task with escalation provided does not flag missing_escalation',
      {
        description: 'Update the auth middleware to validate permissions',
        tests: ['rejects invalid token'],
        implementationSteps: ['1. Check header'],
        typeDefs: 'type AuthMiddleware = unknown',
        scope: { inBounds: ['auth middleware'], outOfBounds: ['database schema'] },
        evidence: ['invalid token test fails before and passes after'],
        escalation: ['Stop if token format is unexpected'],
      },
      'missing_escalation',
    ],
    [
      'non-vague tests pass vague_validation check',
      {
        tests: ['passes tsc', 'validates schema'],
        typeDefs: 'type SchemaResult = boolean',
        scope: { inBounds: ['schema validation'], outOfBounds: ['runtime behavior'] },
        evidence: ['schema validation test passes'],
      },
      'vague_validation',
    ],
  ] as [string, Record<string, unknown>, string][])('%s', (_label, overrides, absentCode) => {
    const task = makeTask(overrides);
    const report = evaluateBriefQuality([task]);
    expect(report.issues.find((i) => i.code === absentCode)).toBeUndefined();
  });
});

describe('multi_file_task write-target semantics', () => {
  it('accepts the real quick-mode planner output for the titleCase feature', () => {
    const markdown = readFileSync(
      join(import.meta.dirname, '../../../testing/fixtures/briefs/quick-titlecase-tasks.md'),
      'utf8',
    );
    const tasks = parseTasks(markdown);
    expect(tasks).toHaveLength(2);
    const report = evaluateBriefQuality(tasks);
    expect(report.issues.filter((i) => i.code === 'multi_file_task')).toHaveLength(0);
    expect(report.passed).toBe(true);
    expect(report.score).toBe(1);
  });

  it.each([
    [
      'a pattern exemplar referenced in the description',
      {
        file: 'src/text.ts',
        description:
          'Create `src/text.ts` exporting a `titleCase` function. This is a small pure string utility matching the style of `src/slug.ts`.',
        implementationSteps: ['Create the file with a single named export `titleCase`.'],
      },
    ],
    [
      'an import source referenced in the steps',
      {
        file: 'src/text.test.ts',
        description: 'Create `src/text.test.ts` with a Vitest suite covering `titleCase`.',
        implementationSteps: [
          "Create the file importing `describe`, `it`, `expect` from `'vitest'` and `titleCase` from `src/text.ts`.",
        ],
      },
    ],
    [
      'a type source referenced in the description',
      {
        file: 'src/engine/spec/formatter.ts',
        description:
          'Update the formatter to accept the `Task` type defined in `src/core/schemas/task.ts`.',
        implementationSteps: ['Update the function signature to take a `Task`.'],
      },
    ],
    [
      'a negated write verb',
      {
        file: 'src/text.ts',
        description: 'Create `src/text.ts` with the helper.',
        implementationSteps: ['Do not modify `src/slug.ts`; keep it as the style reference.'],
      },
    ],
  ] as [string, Record<string, unknown>][])(
    'does not flag %s as multi_file_task',
    (_label, overrides) => {
      const report = evaluateBriefQuality([makeTask(overrides)]);
      expect(report.issues.find((i) => i.code === 'multi_file_task')).toBeUndefined();
    },
  );

  it.each([
    [
      'a second write target in the steps',
      {
        file: 'src/utils/helpers.ts',
        description: 'Create `src/utils/helpers.ts` with a `formatDate` helper.',
        implementationSteps: [
          'Create `src/utils/helpers.ts` exporting `formatDate`.',
          'Update the call site in `src/api.ts` to use the new helper.',
        ],
      },
    ],
    [
      'two write targets joined by a conjunction',
      {
        file: 'src/api.ts',
        description: 'Update `src/api.ts` and `src/utils.ts` to share the new helper.',
        implementationSteps: ['Move the duplicated logic out of both call sites.'],
      },
    ],
  ] as [string, Record<string, unknown>][])('flags %s as multi_file_task', (_label, overrides) => {
    const report = evaluateBriefQuality([makeTask(overrides)]);
    const issue = report.issues.find((i) => i.code === 'multi_file_task');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('src/api.ts');
  });
});

describe('briefErrorMessages', () => {
  it('returns every blocking message and drops warnings', () => {
    const report = evaluateBriefQuality([
      makeTask({ id: 'T001', tests: [], scope: { inBounds: ['x'] }, evidence: ['proof'] }),
      makeTask({ id: 'T002', tests: [], scope: { inBounds: ['x'] }, evidence: ['proof'] }),
    ]);

    expect(briefErrorMessages(report)).toEqual([
      'Task T001 has no tests',
      'Task T002 has no tests',
    ]);
  });
});

describe('isBriefQualityReport', () => {
  it('accepts a valid persisted report', () => {
    expect(
      isBriefQualityReport({
        version: 1,
        passed: false,
        score: 0.8,
        issues: [
          {
            taskId: 'T001',
            severity: 'error',
            code: 'missing_scope',
            message: 'Task T001 has no scope definition',
          },
        ],
      }),
    ).toBe(true);
  });

  it('rejects invalid report shapes', () => {
    expect(
      isBriefQualityReport({
        version: 1,
        passed: true,
        score: '1.00',
        issues: [],
      }),
    ).toBe(false);
    expect(
      isBriefQualityReport({
        version: 1,
        passed: true,
        score: 1,
        issues: [{ taskId: 'T001', severity: 'error', code: 'unknown', message: 'bad' }],
      }),
    ).toBe(false);
  });
});
