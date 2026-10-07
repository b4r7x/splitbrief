import { describe, it, expect } from 'vitest';
import { acceptValidationResults } from './acceptance.js';
import { stageFailureKeys } from './extract-failure-keys.js';
import { parseFailingTests } from './test-failures.js';
import type { ValidationResult } from './result.js';

describe('acceptValidationResults', () => {
  it('exempts a red whose every failure was also red at the run base and names no changed file', () => {
    const results: ValidationResult[] = [
      {
        passed: false,
        stage: 'typecheck',
        error: 'src/unrelated.ts(3,7): error TS2322',
        failureFiles: [],
        preExisting: ['src/unrelated.ts(3,7)'],
      },
    ];
    expect(acceptValidationResults(results, ['src/foo.ts'])).toEqual({
      accepted: true,
      exemptStages: ['typecheck'],
      blockingStages: [],
    });
  });

  it('blocks a red also red at the run base when its evidence names a changed file', () => {
    const results: ValidationResult[] = [
      {
        passed: false,
        stage: 'lint',
        error: 'src/foo.ts:3:1 lint/style',
        failureFiles: ['src/foo.ts'],
        preExisting: ['src/foo.ts:3'],
      },
    ];
    expect(acceptValidationResults(results, ['src/foo.ts'])).toEqual({
      accepted: false,
      exemptStages: [],
      blockingStages: ['lint'],
    });
  });

  it('blocks a red the run base was never asked about', () => {
    const results: ValidationResult[] = [{ passed: false, stage: 'test', failureFiles: [] }];
    expect(acceptValidationResults(results, [])).toEqual({
      accepted: false,
      exemptStages: [],
      blockingStages: ['test'],
    });
  });

  it('blocks a red with one failure the run base did not show', () => {
    const results: ValidationResult[] = [
      {
        passed: false,
        stage: 'typecheck',
        error: 'src/x.ts(12,5): error TS2322\nsrc/b.ts(3,1): error TS2554',
        failureFiles: [],
        preExisting: ['src/x.ts(12,5)'],
      },
    ];
    expect(acceptValidationResults(results, ['src/a.ts'])).toEqual({
      accepted: false,
      exemptStages: [],
      blockingStages: ['typecheck'],
    });
  });

  it('accepts when every stage passed or there are no results', () => {
    expect(
      acceptValidationResults([{ passed: true, stage: 'typecheck', output: 'ok' }], ['src/foo.ts']),
    ).toEqual({ accepted: true, exemptStages: [], blockingStages: [] });
    expect(acceptValidationResults([], ['src/foo.ts'])).toEqual({
      accepted: true,
      exemptStages: [],
      blockingStages: [],
    });
  });

  it('matches changed files despite a leading ./ and backslash separators', () => {
    const results: ValidationResult[] = [
      {
        passed: false,
        stage: 'typecheck',
        error: 'src/foo.ts(1,1): error TS2322',
        failureFiles: ['./src/foo.ts'],
        preExisting: ['src/foo.ts(1,1)'],
      },
    ];
    expect(acceptValidationResults(results, ['src\\foo.ts'])).toEqual({
      accepted: false,
      exemptStages: [],
      blockingStages: ['typecheck'],
    });
  });

  it('never lists a skipped stage in either set', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'lint', skipped: true, output: 'skipped lint' },
      {
        passed: false,
        stage: 'typecheck',
        error: 'src/unrelated.ts(3,7): error TS2322',
        failureFiles: [],
        preExisting: ['src/unrelated.ts(3,7)'],
      },
    ];
    expect(acceptValidationResults(results, ['src/foo.ts'])).toEqual({
      accepted: true,
      exemptStages: ['typecheck'],
      blockingStages: [],
    });
  });

  it('exempts a red suite whose tail differs from the base only in timings, blocks it when a failing test is added', () => {
    const tail = (startAt: string, duration: string, extraTest?: string) =>
      [
        ' FAIL  src/legacy.test.ts > legacy > still red',
        'AssertionError: expected 1 to be 2',
        ' ❯ src/legacy.test.ts:12:20',
        ...(extraTest === undefined
          ? []
          : [` FAIL  ${extraTest}`, 'AssertionError: a new failure']),
        '',
        ' Test Files  1 failed | 41 passed (42)',
        `   Start at  ${startAt}`,
        `   Duration  ${duration}`,
      ].join('\n');
    const preExisting = stageFailureKeys({
      stage: 'test',
      passed: false,
      failingTests: parseFailingTests(tail('02:34:50', '6.93s (transform 1.2s)')),
    });
    const decide = (error: string) =>
      acceptValidationResults(
        [
          {
            passed: false,
            stage: 'test',
            error,
            failingTests: parseFailingTests(error),
            failureFiles: [],
            preExisting,
          },
        ],
        ['src/foo.ts'],
      );
    expect(decide(tail('02:41:07', '7.11s (transform 1.3s)'))).toEqual({
      accepted: true,
      exemptStages: ['test'],
      blockingStages: [],
    });
    expect(
      decide(tail('02:41:07', '7.11s (transform 1.3s)', 'src/other.test.ts > other > newly red')),
    ).toEqual({
      accepted: false,
      exemptStages: [],
      blockingStages: ['test'],
    });
  });

  it('does not exempt a failing stage whose failure evidence was not recorded', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'typecheck', preExisting: ['typecheck failed without diagnostics'] },
    ];
    expect(acceptValidationResults(results, ['src/foo.ts'])).toEqual({
      accepted: false,
      exemptStages: [],
      blockingStages: ['typecheck'],
    });
  });
});
