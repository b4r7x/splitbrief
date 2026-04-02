import { describe, it, expect } from 'vitest';
import { allValidationsPassed } from './index.js';
import type { ValidationResult } from '../../types.js';

describe('allValidationsPassed', () => {
  it('returns true for empty results array', () => {
    expect(allValidationsPassed([])).toBe(true);
  });

  it('returns true when all validations passed', () => {
    const results: ValidationResult[] = [
      { stage: 'typecheck', passed: true },
      { stage: 'lint', passed: true },
      { stage: 'test', passed: true },
    ];
    expect(allValidationsPassed(results)).toBe(true);
  });

  it('returns false when any validation failed', () => {
    const results: ValidationResult[] = [
      { stage: 'typecheck', passed: true },
      { stage: 'lint', passed: false, error: 'lint error' },
      { stage: 'test', passed: true },
    ];
    expect(allValidationsPassed(results)).toBe(false);
  });

  it('returns false when all validations failed', () => {
    const results: ValidationResult[] = [
      { stage: 'typecheck', passed: false, error: 'TS2322' },
      { stage: 'lint', passed: false, error: 'lint error' },
      { stage: 'test', passed: false, error: 'test failed' },
    ];
    expect(allValidationsPassed(results)).toBe(false);
  });

  it('returns false when only one validation exists and it failed', () => {
    const results: ValidationResult[] = [
      { stage: 'typecheck', passed: false, error: 'TS2322' },
    ];
    expect(allValidationsPassed(results)).toBe(false);
  });

  it('returns true when only one validation exists and it passed', () => {
    const results: ValidationResult[] = [
      { stage: 'test', passed: true },
    ];
    expect(allValidationsPassed(results)).toBe(true);
  });
});
