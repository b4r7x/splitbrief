import { describe, it, expect } from 'vitest';
import { createEvidenceLedger, withUpdatedTask } from '../../../core/evidence/ledger-state.js';
import { formatValidationEvidenceForPrompt } from './format-validation.js';
import { makeTask } from '#testing/helpers/factories/task.js';

const VITEST_SUMMARY = 'Test Files  1 passed (1)\n     Tests  4 passed (4)';

function ledgerWithValidation() {
  const task = makeTask({ id: 'T001', title: 'Add titleCase' });
  return withUpdatedTask(
    createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] }),
    task.id,
    (entry) => ({
      ...entry,
      status: 'done',
      validation: [
        { stage: 'typecheck', passed: true, command: 'npm run typecheck' },
        { stage: 'test', passed: true, command: 'npm test', output: VITEST_SUMMARY },
      ],
    }),
  );
}

describe('formatValidationEvidenceForPrompt', () => {
  it('renders command, verdict, and the recorded output verbatim', () => {
    const formatted = formatValidationEvidenceForPrompt(ledgerWithValidation());

    expect(formatted).toContain('T001 — Add titleCase (status: done)');
    expect(formatted).toContain('- typecheck (`npm run typecheck`): passed');
    expect(formatted).toContain('- test (`npm test`): passed');
    expect(formatted).toContain(VITEST_SUMMARY);
  });

  it('falls back to the error summary when a failed stage has no output', () => {
    const task = makeTask({ id: 'T001' });
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] }),
      task.id,
      (entry) => ({
        ...entry,
        validation: [
          { stage: 'test', passed: false, command: 'npm test', errorSummary: '1 test failed' },
        ],
      }),
    );

    const formatted = formatValidationEvidenceForPrompt(ledger);
    expect(formatted).toContain('- test (`npm test`): failed');
    expect(formatted).toContain('1 test failed');
  });

  it('returns undefined without a ledger or without any recorded validation', () => {
    expect(formatValidationEvidenceForPrompt(null)).toBeUndefined();

    const task = makeTask({ id: 'T001' });
    const empty = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    expect(formatValidationEvidenceForPrompt(empty)).toBeUndefined();
  });

  it('a ledger with many large entries formats to ≤ the section cap with an omission marker and retains failed entries', () => {
    const largeOutput = 'x'.repeat(2_000);
    const failedOutput = 'e'.repeat(1_500) + 'FAIL_MARKER_';
    const task = makeTask({ id: 'T001', title: 'Stress validation evidence' });
    const validation = [
      { stage: 'test' as const, passed: false, command: 'npm test', output: failedOutput },
      ...Array.from({ length: 40 }, (_, i) => ({
        stage: 'lint' as const,
        passed: true,
        command: `npm run lint --batch-${i}`,
        output: largeOutput,
      })),
    ];
    const ledger = withUpdatedTask(
      createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] }),
      task.id,
      (entry) => ({ ...entry, status: 'done', validation }),
    );

    const formatted = formatValidationEvidenceForPrompt(ledger);
    expect(formatted).toBeDefined();
    expect(formatted?.length ?? 0).toBeLessThanOrEqual(30_000);
    expect(formatted).toContain('[…');
    expect(formatted).toContain('entries omitted …]');
    expect(formatted).toContain('- test (`npm test`): failed');
    expect(formatted).toContain('FAIL_MARKER_');
  });
});
