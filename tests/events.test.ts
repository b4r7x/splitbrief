import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allValidationsPassed } from '../src/engine/orchestrator/index.js';
import type { ValidationResult } from '../src/types.js';

describe('allValidationsPassed', () => {
  it('returns true for empty results array', () => {
    assert.equal(allValidationsPassed([]), true);
  });

  it('returns true when all validations passed', () => {
    const results: ValidationResult[] = [
      { stage: 'typecheck', passed: true },
      { stage: 'lint', passed: true },
      { stage: 'test', passed: true },
    ];
    assert.equal(allValidationsPassed(results), true);
  });

  it('returns false when any validation failed', () => {
    const results: ValidationResult[] = [
      { stage: 'typecheck', passed: true },
      { stage: 'lint', passed: false, error: 'lint error' },
      { stage: 'test', passed: true },
    ];
    assert.equal(allValidationsPassed(results), false);
  });

  it('returns false when all validations failed', () => {
    const results: ValidationResult[] = [
      { stage: 'typecheck', passed: false, error: 'TS2322' },
      { stage: 'lint', passed: false, error: 'lint error' },
      { stage: 'test', passed: false, error: 'test failed' },
    ];
    assert.equal(allValidationsPassed(results), false);
  });

  it('returns false when only one validation exists and it failed', () => {
    const results: ValidationResult[] = [
      { stage: 'typecheck', passed: false, error: 'TS2322' },
    ];
    assert.equal(allValidationsPassed(results), false);
  });

  it('returns true when only one validation exists and it passed', () => {
    const results: ValidationResult[] = [
      { stage: 'test', passed: true },
    ];
    assert.equal(allValidationsPassed(results), true);
  });
});
