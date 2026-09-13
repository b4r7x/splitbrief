import { describe, it, expect } from 'vitest';
import { decideValidationAcceptance } from './acceptance.js';
import { extractFailureKeys } from './extract-failure-keys.js';
import type { ValidationResult } from './result.js';
import type { ValidationStage } from '../../../core/schemas/enums.js';

function baseline(stages: ValidationStage[]): ReadonlySet<ValidationStage> {
  return new Set(stages);
}

describe('decideValidationAcceptance', () => {
  it('exempts a stage red at baseline whose evidence names no changed file, and accepts', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'typecheck', failureFiles: ['src/unrelated.ts'] },
    ];
    expect(
      decideValidationAcceptance({
        results,
        baselineFailingStages: baseline(['typecheck']),
        changedFiles: ['src/foo.ts'],
      }),
    ).toEqual({ accepted: true, exemptStages: ['typecheck'], blockingStages: [] });
  });

  it('blocks a stage red at baseline whose evidence names one of the changed files', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'lint', failureFiles: ['src/foo.ts'] },
    ];
    expect(
      decideValidationAcceptance({
        results,
        baselineFailingStages: baseline(['lint']),
        changedFiles: ['src/foo.ts'],
      }),
    ).toEqual({ accepted: false, exemptStages: [], blockingStages: ['lint'] });
  });

  it('always blocks a failing stage that was green at baseline, even with empty evidence', () => {
    const results: ValidationResult[] = [{ passed: false, stage: 'test', failureFiles: [] }];
    expect(
      decideValidationAcceptance({
        results,
        baselineFailingStages: baseline(['typecheck']),
        changedFiles: [],
      }),
    ).toEqual({ accepted: false, exemptStages: [], blockingStages: ['test'] });
  });

  it('accepts when every stage passed', () => {
    const results: ValidationResult[] = [{ passed: true, stage: 'typecheck', output: 'ok' }];
    expect(
      decideValidationAcceptance({
        results,
        baselineFailingStages: baseline(['typecheck']),
        changedFiles: ['src/foo.ts'],
      }),
    ).toEqual({ accepted: true, exemptStages: [], blockingStages: [] });
  });

  it('accepts when there are no results', () => {
    expect(
      decideValidationAcceptance({
        results: [],
        baselineFailingStages: baseline(['typecheck']),
        changedFiles: ['src/foo.ts'],
      }),
    ).toEqual({ accepted: true, exemptStages: [], blockingStages: [] });
  });

  it('matches changed files despite a leading ./ and backslash separators', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'typecheck', failureFiles: ['./src/foo.ts'] },
    ];
    expect(
      decideValidationAcceptance({
        results,
        baselineFailingStages: baseline(['typecheck']),
        changedFiles: ['src\\foo.ts'],
      }),
    ).toEqual({ accepted: false, exemptStages: [], blockingStages: ['typecheck'] });
  });

  it('never lists a skipped stage in either set', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'lint', skipped: true, output: 'skipped lint' },
      { passed: false, stage: 'typecheck', failureFiles: ['src/unrelated.ts'] },
    ];
    expect(
      decideValidationAcceptance({
        results,
        baselineFailingStages: baseline(['lint', 'typecheck']),
        changedFiles: ['src/foo.ts'],
      }),
    ).toEqual({ accepted: true, exemptStages: ['typecheck'], blockingStages: [] });
  });

  it('does not exempt a failure produced by a different command than the baseline probed', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'test', command: 'npm test -- src/bar.test.ts', failureFiles: [] },
    ];
    expect(
      decideValidationAcceptance({
        results,
        baselineFailingStages: baseline(['test']),
        baselineCommands: { test: 'npm test -- src/foo.test.ts' },
        changedFiles: ['src/bar.ts'],
      }),
    ).toEqual({ accepted: false, exemptStages: [], blockingStages: ['test'] });
  });

  it('exempts the same stage when the command matches the one probed at baseline', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'test', command: 'npm test -- src/foo.test.ts', failureFiles: [] },
    ];
    expect(
      decideValidationAcceptance({
        results,
        baselineFailingStages: baseline(['test']),
        baselineCommands: { test: 'npm test -- src/foo.test.ts' },
        changedFiles: ['src/bar.ts'],
      }),
    ).toEqual({ accepted: true, exemptStages: ['test'], blockingStages: [] });
  });

  it('new failure in untouched file is not exempt', () => {
    const results: ValidationResult[] = [
      {
        passed: false,
        stage: 'typecheck',
        error: 'src/x.ts(12,5): error TS2322\nsrc/b.ts(3,1): error TS2554',
        failureFiles: [],
      },
    ];
    expect(
      decideValidationAcceptance({
        results,
        baselineFailingStages: baseline(['typecheck']),
        baselineFailureKeys: { typecheck: new Set(['src/x.ts(12,5)']) },
        changedFiles: ['src/a.ts'],
      }),
    ).toEqual({ accepted: false, exemptStages: [], blockingStages: ['typecheck'] });
  });

  it('identical failure set stays exempt', () => {
    const results: ValidationResult[] = [
      {
        passed: false,
        stage: 'typecheck',
        error: 'src/x.ts(12,5): error TS2322',
        failureFiles: [],
      },
    ];
    expect(
      decideValidationAcceptance({
        results,
        baselineFailingStages: baseline(['typecheck']),
        baselineFailureKeys: { typecheck: new Set(['src/x.ts(12,5)']) },
        changedFiles: ['src/a.ts'],
      }),
    ).toEqual({ accepted: true, exemptStages: ['typecheck'], blockingStages: [] });
  });

  it('exempts a red suite whose tail differs only in timings, blocks it when a frame is added', () => {
    const tail = (startAt: string, duration: string, extraFrame?: string) =>
      [
        ' FAIL  src/legacy.test.ts > legacy > still red',
        'AssertionError: expected 1 to be 2',
        ' ❯ src/legacy.test.ts:12:20',
        ...(extraFrame === undefined ? [] : [` ❯ ${extraFrame}`]),
        '',
        ' Test Files  1 failed | 41 passed (42)',
        `   Start at  ${startAt}`,
        `   Duration  ${duration}`,
      ].join('\n');
    const baselineFailureKeys = {
      test: new Set(extractFailureKeys(tail('02:34:50', '6.93s (transform 1.2s)'))),
    };
    const decide = (error: string) =>
      decideValidationAcceptance({
        results: [{ passed: false, stage: 'test', error, failureFiles: [] }],
        baselineFailingStages: baseline(['test']),
        baselineFailureKeys,
        changedFiles: ['src/foo.ts'],
      });
    expect(decide(tail('02:41:07', '7.11s (transform 1.3s)'))).toEqual({
      accepted: true,
      exemptStages: ['test'],
      blockingStages: [],
    });
    expect(decide(tail('02:41:07', '7.11s (transform 1.3s)', 'src/other.ts:9:1'))).toEqual({
      accepted: false,
      exemptStages: [],
      blockingStages: ['test'],
    });
  });

  it('does not exempt a failing stage whose failure evidence was not recorded', () => {
    const results: ValidationResult[] = [{ passed: false, stage: 'typecheck' }];
    expect(
      decideValidationAcceptance({
        results,
        baselineFailingStages: baseline(['typecheck']),
        changedFiles: ['src/foo.ts'],
      }),
    ).toEqual({ accepted: false, exemptStages: [], blockingStages: ['typecheck'] });
  });
});
