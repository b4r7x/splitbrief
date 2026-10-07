import { describe, it, expect } from 'vitest';
import { formatValidationError, validationFailureLine } from './format-error.js';
import type { ValidationResult } from './result.js';
import type { ValidationAcceptance } from './acceptance.js';
import type { ValidationStage } from '../../../core/schemas/enums.js';

function acceptance(
  exemptStages: readonly ValidationStage[] = [],
  blockingStages: readonly ValidationStage[] = [],
): ValidationAcceptance {
  return { accepted: blockingStages.length === 0, exemptStages, blockingStages };
}

describe('formatValidationError', () => {
  it('returns empty string when all passed', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'typecheck', output: 'ok' },
      { passed: true, stage: 'lint', output: 'ok' },
    ];
    expect(formatValidationError(results, acceptance())).toBe('');
  });

  it('returns empty string for empty results', () => {
    expect(formatValidationError([], acceptance())).toBe('');
  });

  it('names every blocking failed result with its own errors', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'typecheck', output: 'ok' },
      { passed: false, stage: 'lint', error: 'Unexpected token' },
      { passed: false, stage: 'test', error: 'Test failed' },
    ];
    const error = formatValidationError(results, acceptance([], ['lint', 'test']));
    expect(error.split('\n')).toEqual([
      'Your previous code had an error. Fix it.',
      'Error type: lint',
      'Error message: Unexpected token',
      'Error type: test',
      'Error message: Test failed',
      'Fix the error and output the complete corrected file.',
    ]);
  });

  it('keeps the head and the tail of a long typecheck failure', () => {
    const longError = Array.from({ length: 60 }, (_, i) => `Error line ${i + 1}`).join('\n');
    const results: ValidationResult[] = [{ passed: false, stage: 'typecheck', error: longError }];
    const error = formatValidationError(results, acceptance([], ['typecheck']));
    expect(error).toContain('Error line 20');
    expect(error).not.toContain('Error line 21');
    expect(error).not.toContain('Error line 40');
    expect(error).toContain('Error line 41');
    expect(error).toContain('Error line 60');
  });

  it('lets a lint diagnostic survive a long config preamble', () => {
    const lintOutput = [
      'biome.json:38:13 deserialize  DEPRECATED  ━━━━━━━━',
      ...Array.from({ length: 24 }, (_, i) => `  notice line ${i + 1}`),
      'src/components/rule-header.test.tsx format ━━━━━━━━',
      '  × Formatter would have printed the following content:',
      '    67 │ - expect(a).toBe(b);',
      '    67 │ + expect(a).toBe(',
      'Found 1 error.',
    ].join('\n');
    const results: ValidationResult[] = [{ passed: false, stage: 'lint', error: lintOutput }];
    const error = formatValidationError(results, acceptance([], ['lint']));
    expect(error).toContain('Formatter would have printed');
    expect(error).toContain('rule-header.test.tsx');
    expect(error).toContain('Found 1 error.');
  });

  it('keeps the tail of a long test failure so vitest FAIL summary survives', () => {
    const longError = [
      ...Array.from({ length: 30 }, (_, i) => `Noise line ${i + 1}`),
      'Tests  1 failed | 2 passed',
      'FAIL  src/foo.test.ts > does the thing',
    ].join('\n');
    const results: ValidationResult[] = [{ passed: false, stage: 'test', error: longError }];
    const error = formatValidationError(results, acceptance([], ['test']));
    expect(error).toContain('FAIL  src/foo.test.ts > does the thing');
    expect(error).toContain('Tests  1 failed | 2 passed');
    expect(error.split('\n')).not.toContain('Noise line 1');
  });

  it('returns empty string when every failing stage is exempt', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'typecheck', error: 'type error' },
    ];
    expect(formatValidationError(results, acceptance(['typecheck']))).toBe('');
  });

  it('names the exempt stages as pre-existing and targets the blocking failure', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'typecheck', error: 'type error' },
      { passed: false, stage: 'lint', error: 'lint error' },
    ];
    const error = formatValidationError(results, acceptance(['typecheck'], ['lint']));
    expect(error).toContain('pre-existing');
    expect(error).toContain('typecheck');
    expect(error).toContain('not to be fixed');
    expect(error).toContain('Error type: lint');
    expect(error).toContain('lint error');
  });

  it('keeps the implementer-attribution message when no stage is exempt', () => {
    const results: ValidationResult[] = [{ passed: false, stage: 'lint', error: 'lint error' }];
    const error = formatValidationError(results, acceptance([], ['lint']));
    expect(error).toContain('Your previous code had an error');
    expect(error).not.toContain('pre-existing');
  });

  it('falls back to output when error is undefined', () => {
    const results: ValidationResult[] = [
      { passed: false, stage: 'lint', error: undefined, output: 'some lint output' },
    ];
    const error = formatValidationError(results, acceptance([], ['lint']));
    expect(error).toContain('lint');
    expect(error).toContain('some lint output');
  });
});

// Captured from the S11 run's T008 attempt 10 (session.jsonl, 2026-10-07T10:48:10Z): a Biome
// deprecation notice about biome.json leads the output, the brief's format diagnostic follows.
const BIOME_NOTICE_THEN_FORMAT = [
  'biome.json:38:13 deserialize  DEPRECATED  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '  i The use of the recommended field has been deprecated, and will removed in the next major version of Biome. Use preset instead.',
  '  ',
  '    36 │     "lineWidth": 100',
  '    37 │   },',
  '  > 38 │   "linter": {',
  '       │             ^',
  '  ',
  '  i Migrate the configuration with the proper command',
  '  ',
  '  $ biome migrate',
  '  ',
  '',
  'src/engine/orchestrator/recovery/actions.test.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '  × Formatter would have printed the following content:',
  '  ',
  '    508     │ - ······expect.arrayContaining([',
  "        508 │ + ······expect.arrayContaining(['recovery_action_selected',·'seat_switched',·'recovery_resolved']),",
  '  ',
  '',
  'check ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '  × Some errors were emitted while running checks.',
].join('\n');

describe('validationFailureLine', () => {
  it('quotes the line that names a file the brief changed, never the notice before it', () => {
    const results: ValidationResult[] = [
      { passed: true, stage: 'typecheck', output: 'ok' },
      {
        passed: false,
        stage: 'lint',
        error: BIOME_NOTICE_THEN_FORMAT,
        failureFiles: ['src/engine/orchestrator/recovery/actions.test.ts'],
      },
    ];

    expect(validationFailureLine(results, acceptance([], ['lint']))).toBe(
      'lint failed: src/engine/orchestrator/recovery/actions.test.ts format',
    );
  });

  it('quotes the first error line when the output names no file of the brief', () => {
    const results: ValidationResult[] = [
      {
        passed: false,
        stage: 'lint',
        error: BIOME_NOTICE_THEN_FORMAT,
        failureFiles: [],
      },
    ];

    expect(validationFailureLine(results, acceptance([], ['lint']))).toBe(
      'lint failed: × Formatter would have printed the following content:',
    );
  });

  it('quotes a type error as the checker printed it', () => {
    const results: ValidationResult[] = [
      {
        passed: false,
        stage: 'typecheck',
        error:
          "> tsc --noEmit\n\nsrc/core/config/load/record-seat.ts(122,7): error TS2367: This comparison appears to be unintentional because the types 'string' and 'number' have no overlap.",
        failureFiles: ['src/core/config/load/record-seat.ts'],
      },
    ];

    expect(validationFailureLine(results, acceptance([], ['typecheck']))).toBe(
      "typecheck failed: src/core/config/load/record-seat.ts(122,7): error TS2367: This comparison appears to be unintentional because the types 'string' and 'number' have no overlap.",
    );
  });

  it('is empty when no stage blocks', () => {
    const results: ValidationResult[] = [{ passed: true, stage: 'lint', output: 'ok' }];
    expect(validationFailureLine(results, acceptance())).toBe('');
  });
});
