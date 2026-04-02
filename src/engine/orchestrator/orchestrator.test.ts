import { describe, it, expect } from 'vitest';
import { runWorkflow, allValidationsPassed, hasDependencyFailed, estimateCostSavings } from './index.js';
import { makeTask, makeUsage } from '#testing/helpers/fixtures.js';
import type { ValidationResult, TokenUsage } from '../../types.js';

describe('runWorkflow', () => {
  it('accepts an options object parameter', () => {
    expect(runWorkflow.length).toBe(1);
  });
});

describe('allValidationsPassed', () => {
  it('returns true for empty results array', () => {
    expect(allValidationsPassed([])).toBe(true);
  });

  it('returns true when all results passed', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'typecheck', output: 'ok' },
      { passed: true, stage: 'lint', output: 'ok' },
      { passed: true, stage: 'test', output: 'ok' },
    ];
    expect(allValidationsPassed(results)).toBe(true);
  });

  it('returns false when any result failed', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'typecheck', output: 'ok' },
      { passed: false, stage: 'lint', error: 'lint error' },
    ];
    expect(allValidationsPassed(results)).toBe(false);
  });

  it('returns false when all results failed', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'typecheck', error: 'type error' },
    ];
    expect(allValidationsPassed(results)).toBe(false);
  });
});

describe('hasDependencyFailed', () => {
  function makeDepTask(deps: string[]) {
    return makeTask({ id: 'T010', title: 'Test task', file: 'src/test.ts', description: 'test', dependsOn: deps });
  }

  it('returns false when task has no dependencies', () => {
    expect(hasDependencyFailed(makeDepTask([]), ['T001'], ['T002'])).toBe(false);
  });

  it('returns true when a dependency is in failedTasks', () => {
    expect(hasDependencyFailed(makeDepTask(['T001', 'T002']), ['T001'], [])).toBe(true);
  });

  it('returns true when a dependency is in skippedTasks', () => {
    expect(hasDependencyFailed(makeDepTask(['T003']), [], ['T003'])).toBe(true);
  });

  it('returns false when dependencies are not in failed or skipped', () => {
    expect(hasDependencyFailed(makeDepTask(['T001', 'T002']), ['T005'], ['T006'])).toBe(false);
  });
});

describe('estimateCostSavings', () => {
  it('returns $0.00 when no implementer tokens used', () => {
    const usage = makeUsage({ plannerInput: 1000, plannerOutput: 500 });
    expect(estimateCostSavings(usage, 'claude-code', 'ollama')).toBe('$0.00');
  });

  it('calculates savings for known token values', () => {
    const usage = makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 });
    expect(estimateCostSavings(usage, 'claude-code', 'ollama')).toBe('$30.00');
  });

  it('subtracts actual Opus cost from hypothetical', () => {
    const usage = makeUsage({
      plannerInput: 1_000_000,
      plannerOutput: 100_000,
      implementerInput: 2_000_000,
      implementerOutput: 500_000,
    });
    expect(estimateCostSavings(usage, 'claude-code', 'ollama')).toBe('$15.00');
  });

  it('returns $0.00 when savings would be negative', () => {
    const usage = makeUsage({
      plannerInput: 10_000_000,
      plannerOutput: 5_000_000,
      implementerInput: 100,
      implementerOutput: 50,
    });
    expect(estimateCostSavings(usage, 'claude-code', 'ollama')).toBe('$0.00');
  });
});
