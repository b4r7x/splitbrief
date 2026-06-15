import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { validationRow } from './event-format.js';

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
  it('renders a passing stage as ✓ and a not-run stage as ○', () => {
    const row = validationRow(
      validateEvent({ stages: { typecheck: true, lint: false, test: false } }),
    );
    expect(row).toContain('typecheck ✓');
    expect(row).toContain('lint ○');
    expect(row).toContain('test ○');
  });

  it('renders a skipped stage distinctly rather than as a passing ✓', () => {
    const row = validationRow(
      validateEvent({
        stages: { typecheck: true, lint: false, test: true },
        skipped: { lint: true },
      }),
    );
    expect(row).toContain('lint –');
    expect(row).not.toContain('lint ✓');
    expect(row).toContain('typecheck ✓');
    expect(row).toContain('test ✓');
  });
});
