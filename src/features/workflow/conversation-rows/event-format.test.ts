import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { baselineValidationRow, validationSummarySegments } from './event-format.js';

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

function summaryText(event: Extract<EngineEvent, { type: 'validate' }>): string {
  return validationSummarySegments(event)
    .map((segment) => segment.text)
    .join('');
}

function stageTone(
  event: Extract<EngineEvent, { type: 'validate' }>,
  stage: string,
): string | undefined {
  return validationSummarySegments(event).find((segment) => segment.text.endsWith(` ${stage}`))
    ?.tone;
}

describe('validationSummarySegments', () => {
  it('tones a passing stage apart from a stage that never ran', () => {
    const event = validateEvent({ stages: { typecheck: true, lint: false, test: false } });

    expect(stageTone(event, 'typecheck')).toBe('success');
    expect(stageTone(event, 'lint')).toBe('textDim');
    expect(stageTone(event, 'test')).toBe('textDim');
  });

  it('tones a failed stage apart from a stage that never ran', () => {
    const event = validateEvent({
      passed: false,
      stages: { typecheck: true, lint: false, test: false },
      attempted: { typecheck: true, lint: true, test: false },
    });

    expect(stageTone(event, 'typecheck')).toBe('success');
    expect(stageTone(event, 'lint')).toBe('error');
    expect(stageTone(event, 'test')).toBe('textDim');
  });

  it('tones a skipped stage as neither passed nor failed', () => {
    const event = validateEvent({
      passed: false,
      stages: { typecheck: true, lint: false, test: true },
      skipped: { lint: true },
    });

    expect(stageTone(event, 'lint')).toBe('textDim');
    expect(stageTone(event, 'typecheck')).toBe('success');
    expect(stageTone(event, 'test')).toBe('success');
  });

  it('tones the running stage distinctly', () => {
    const event = validateEvent({
      status: 'running',
      stages: { typecheck: false, lint: false, test: false },
      activeStage: 'typecheck',
      commands: { typecheck: 'npm run typecheck' },
    });

    expect(stageTone(event, 'typecheck')).toBe('info');
    expect(stageTone(event, 'lint')).toBe('textDim');
  });

  // Commands are what made this row wrap mid-stage; they live on the error block below it now.
  it('omits stage commands so the row stays on one line', () => {
    const text = summaryText(
      validateEvent({
        passed: false,
        stages: { typecheck: true, lint: false, test: false },
        attempted: { typecheck: true, lint: true, test: false },
        commands: { typecheck: 'npx tsc --noEmit', lint: 'npm run lint' },
      }),
    );

    expect(text).not.toContain('npm run lint');
    expect(text).not.toContain('npx tsc --noEmit');
    expect(getTerminalCellWidth(text)).toBeLessThan(60);
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
