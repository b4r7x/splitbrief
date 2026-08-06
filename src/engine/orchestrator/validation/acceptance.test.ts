import { describe, it, expect } from 'vitest';
import { decideValidationAcceptance } from './acceptance.js';
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

  it('accepts when nothing fails and when there are no results', () => {
    const results: ValidationResult[] = [{ passed: true, stage: 'typecheck', output: 'ok' }];
    expect(
      decideValidationAcceptance({
        results,
        baselineFailingStages: baseline(['typecheck']),
        changedFiles: ['src/foo.ts'],
      }),
    ).toEqual({ accepted: true, exemptStages: [], blockingStages: [] });
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
