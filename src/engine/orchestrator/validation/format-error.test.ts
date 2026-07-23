import { describe, it, expect } from 'vitest';
import { formatValidationError } from './format-error.js';
import type { ValidationResult } from './result.js';

describe('formatValidationError', () => {
  it('returns empty string when all passed', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'typecheck', output: 'ok' },
      { passed: true, stage: 'lint', output: 'ok' },
    ];
    expect(formatValidationError(results)).toBe('');
  });

  it('returns empty string for empty results', () => {
    expect(formatValidationError([])).toBe('');
  });

  it('extracts first failed result', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'typecheck', output: 'ok' },
      { passed: false, stage: 'lint', error: 'Unexpected token' },
      { passed: false, stage: 'test', error: 'Test failed' },
    ];
    const error = formatValidationError(results);
    expect(error).toContain('lint');
    expect(error).toContain('Unexpected token');
  });

  it('truncates error to 20 lines', () => {
    const longError = Array.from({ length: 30 }, (_, i) => `Error line ${i + 1}`).join('\n');
    const results: ValidationResult[] = [{ passed: false, stage: 'typecheck', error: longError }];
    const error = formatValidationError(results);
    expect(error).not.toContain('Error line 21');
    expect(error).toContain('Error line 20');
  });

  it('keeps the tail of a long test failure so vitest FAIL summary survives', () => {
    const longError = [
      ...Array.from({ length: 30 }, (_, i) => `Noise line ${i + 1}`),
      'Tests  1 failed | 2 passed',
      'FAIL  src/foo.test.ts > does the thing',
    ].join('\n');
    const results: ValidationResult[] = [{ passed: false, stage: 'test', error: longError }];
    const error = formatValidationError(results);
    expect(error).toContain('FAIL  src/foo.test.ts > does the thing');
    expect(error).toContain('Tests  1 failed | 2 passed');
    expect(error.split('\n')).not.toContain('Noise line 1');
  });

  it('attributes a pre-existing failing stage to the baseline, not the implementer', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'typecheck', error: 'type error' },
    ];
    const error = formatValidationError(results, new Set(['typecheck']));
    expect(error).toContain('pre-existing failure');
    expect(error).toContain('not caused by this task');
    expect(error).not.toContain('Your previous code had an error');
  });

  it('keeps the implementer-attribution message when the failing stage is not in the baseline', () => {
    const results: ValidationResult[] = [{ passed: false, stage: 'lint', error: 'lint error' }];
    const error = formatValidationError(results, new Set(['typecheck']));
    expect(error).toContain('Your previous code had an error');
    expect(error).not.toContain('pre-existing');
  });
});

describe('formatValidationError edge cases', () => {
  it('falls back to output when error is undefined', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'lint', error: undefined, output: 'some lint output' },
    ];
    const error = formatValidationError(results);
    expect(error).toContain('lint');
    expect(error).toContain('some lint output');
  });
});
