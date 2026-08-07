import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { baselineValidationRow, validationRow } from './event-format.js';

function validateEvent(
  overrides: Partial<Extract<EngineEvent, { type: 'validate' }>>,
): Extract<EngineEvent, { type: 'validate' }> {
  return {
    type: 'validate',
    ts: 0,
    phase: 'implementing',
    taskId: taskId('T001'),
    status: 'done',
    passed: true,
    stages: { typecheck: true, lint: true, test: true },
    ...overrides,
  };
}

describe('validationRow', () => {
  it('renders passing and not-run stages as distinct states', () => {
    const row = validationRow(
      validateEvent({ stages: { typecheck: true, lint: false, test: false } }),
    );
    expect(row).toContain('typecheck passed');
    expect(row).toContain('lint not-run');
    expect(row).toContain('test not-run');
  });

  it('renders failed validation stages distinctly from not-run stages', () => {
    const row = validationRow(
      validateEvent({
        passed: false,
        stages: { typecheck: true, lint: false, test: false },
        attempted: { typecheck: true, lint: true, test: false },
      }),
    );

    expect(row).toContain('typecheck passed');
    expect(row).toContain('lint failed');
    expect(row).toContain('test not-run');
    expect(row).not.toContain('typecheck failed');
    expect(row).not.toContain('lint not-run');
    expect(row).not.toContain('test failed');
  });

  it('renders a skipped stage distinctly rather than as passed or failed', () => {
    const row = validationRow(
      validateEvent({
        passed: false,
        stages: { typecheck: true, lint: false, test: true },
        skipped: { lint: true },
      }),
    );
    expect(row).toContain('lint skipped');
    expect(row).not.toContain('lint passed');
    expect(row).not.toContain('lint failed');
    expect(row).toContain('typecheck passed');
    expect(row).toContain('test passed');
  });

  it('renders active validation command metadata', () => {
    const row = validationRow(
      validateEvent({
        status: 'running',
        stages: { typecheck: false, lint: false, test: false },
        activeStage: 'typecheck',
        commands: { typecheck: 'npm run typecheck' },
      }),
    );

    expect(row).toContain('typecheck (npm run typecheck) running');
    expect(row).toContain('lint not-run');
    expect(row).toContain('test not-run');
  });
});

function baselineEvent(
  overrides: Partial<Extract<EngineEvent, { type: 'validation_baseline' }>>,
): Extract<EngineEvent, { type: 'validation_baseline' }> {
  return {
    type: 'validation_baseline',
    ts: 0,
    phase: 'implementing',
    status: 'done',
    stages: { typecheck: true, lint: true, test: true },
    ...overrides,
  };
}

describe('baselineValidationRow', () => {
  it('renders passed, failed, and not-run baseline stages as distinct states', () => {
    const row = baselineValidationRow(
      baselineEvent({
        stages: { typecheck: true, lint: false, test: false },
        failing: { lint: true },
      }),
    );

    expect(row).toContain('typecheck passed');
    expect(row).toContain('lint failed');
    expect(row).toContain('test not-run');
    expect(row).not.toContain('lint passed');
    expect(row).not.toContain('lint not-run');
  });

  it('renders the active stage while the baseline probe is running', () => {
    const row = baselineValidationRow(
      baselineEvent({
        status: 'running',
        stages: { typecheck: true, lint: false, test: false },
        activeStage: 'lint',
        commands: { lint: 'cargo clippy --no-deps' },
      }),
    );

    expect(row).toContain('lint (cargo clippy --no-deps) running');
    expect(row).toContain('typecheck passed');
    expect(row).toContain('test not-run');
  });
});
