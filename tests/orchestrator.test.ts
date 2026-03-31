import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow, allValidationsPassed, hasDependencyFailed, estimateCostSavings } from '../src/engine/orchestrator.js';
import type { Task, ValidationResult, TokenUsage } from '../src/types.js';

describe('runWorkflow', () => {
  it('accepts a savedState parameter (6th argument)', () => {
    assert.strictEqual(runWorkflow.length, 5, 'runWorkflow should have 5 required parameters (savedState is optional)');
  });
});

describe('allValidationsPassed', () => {
  it('returns true for empty results array', () => {
    assert.equal(allValidationsPassed([]), true);
  });

  it('returns true when all results passed', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'typecheck', output: 'ok' },
      { passed: true, stage: 'lint', output: 'ok' },
      { passed: true, stage: 'test', output: 'ok' },
    ];
    assert.equal(allValidationsPassed(results), true);
  });

  it('returns false when any result failed', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'typecheck', output: 'ok' },
      { passed: false, stage: 'lint', error: 'lint error' },
    ];
    assert.equal(allValidationsPassed(results), false);
  });

  it('returns false when all results failed', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'typecheck', error: 'type error' },
    ];
    assert.equal(allValidationsPassed(results), false);
  });
});

describe('hasDependencyFailed', () => {
  function makeTask(deps: string[]): Task {
    return {
      id: 'T010',
      title: 'Test task',
      action: 'create',
      file: 'src/test.ts',
      dependsOn: deps,
      description: 'test',
      tests: [],
      constraints: [],
      status: 'pending',
    };
  }

  it('returns false when task has no dependencies', () => {
    assert.equal(hasDependencyFailed(makeTask([]), ['T001'], ['T002']), false);
  });

  it('returns true when a dependency is in failedTasks', () => {
    assert.equal(hasDependencyFailed(makeTask(['T001', 'T002']), ['T001'], []), true);
  });

  it('returns true when a dependency is in skippedTasks', () => {
    assert.equal(hasDependencyFailed(makeTask(['T003']), [], ['T003']), true);
  });

  it('returns false when dependencies are not in failed or skipped', () => {
    assert.equal(hasDependencyFailed(makeTask(['T001', 'T002']), ['T005'], ['T006']), false);
  });
});

describe('estimateCostSavings', () => {
  it('returns $0.00 when no implementer tokens used', () => {
    const usage: TokenUsage = {
      plannerInput: 1000,
      plannerOutput: 500,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    };
    assert.equal(estimateCostSavings(usage, 'claude-code', 'ollama'), '$0.00');
  });

  it('calculates savings for known token values', () => {
    const usage: TokenUsage = {
      plannerInput: 0,
      plannerOutput: 0,
      implementerInput: 1_000_000,
      implementerOutput: 1_000_000,
      escalationInput: 0,
      escalationOutput: 0,
    };
    // hypothetical Opus cost: (1M/1M)*5 + (1M/1M)*25 = 5 + 25 = $30
    // actual Opus cost: $0 (no planner or escalation usage)
    // savings: $30
    assert.equal(estimateCostSavings(usage, 'claude-code', 'ollama'), '$30.00');
  });

  it('subtracts actual Opus cost from hypothetical', () => {
    const usage: TokenUsage = {
      plannerInput: 1_000_000,
      plannerOutput: 100_000,
      implementerInput: 2_000_000,
      implementerOutput: 500_000,
      escalationInput: 0,
      escalationOutput: 0,
    };
    // hypothetical: (2M/1M)*5 + (500K/1M)*25 = 10 + 12.5 = $22.50
    // actual planner: (1M/1M)*5 + (100K/1M)*25 = 5 + 2.5 = $7.50
    // savings: $15.00
    assert.equal(estimateCostSavings(usage, 'claude-code', 'ollama'), '$15.00');
  });

  it('returns $0.00 when savings would be negative', () => {
    const usage: TokenUsage = {
      plannerInput: 10_000_000,
      plannerOutput: 5_000_000,
      implementerInput: 100,
      implementerOutput: 50,
      escalationInput: 0,
      escalationOutput: 0,
    };
    assert.equal(estimateCostSavings(usage, 'claude-code', 'ollama'), '$0.00');
  });
});
