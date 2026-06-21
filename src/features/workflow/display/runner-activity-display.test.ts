import { describe, expect, it } from 'vitest';
import {
  cleanRunnerActivityText,
  runnerActivityDiagnosticPreview,
  runnerActivityLedgerItem,
} from './runner-activity-display.js';

describe('runnerActivityLedgerItem', () => {
  it('hides internal interruption codes from compact activity', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'aborted',
        kind: 'error',
        label: 'aborted runner_interrupted',
        diagnosticPartial: 'cancelled',
      }),
    ).toMatchObject({
      label: 'WARN',
      value: 'current turn interrupted: cancelled',
      diagnosticPreview: 'cancelled',
      tone: 'warning',
      valueTone: 'warning',
      severity: 'warning',
      pinned: true,
    });
  });

  it('keeps real terminal failures distinct from interruption', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'timeout',
        kind: 'error',
        label: 'timeout command_timeout',
        diagnosticPartial: 'Command timed out',
      }),
    ).toMatchObject({
      label: 'ERR',
      value: 'command_timeout: Command timed out',
      diagnosticPreview: 'Command timed out',
      tone: 'error',
      valueTone: 'error',
      severity: 'error',
      pinned: true,
    });
  });
});

describe('runnerActivityDiagnosticPreview', () => {
  it('uses bounded sanitized diagnostics for warning and error activity', () => {
    const preview = runnerActivityDiagnosticPreview(
      {
        stage: 'warning',
        kind: 'warning',
        label: 'warning stderr',
        diagnosticPartial: 'stderr sk-abcdefghijklmnopqrstuvwxyz keeps going',
      },
      24,
    );

    expect(preview).toBe('stderr sk-***REDACTED**…');
  });

  it('falls back to textPartial when no diagnosticPartial is available', () => {
    expect(
      runnerActivityDiagnosticPreview({
        stage: 'warning',
        kind: 'warning',
        label: 'warning stderr',
        textPartial: 'stderr preview',
      }),
    ).toBe('stderr preview');
  });
});

describe('cleanRunnerActivityText', () => {
  it('sanitizes terminal controls, secrets, and internal runner interruption code', () => {
    expect(
      cleanRunnerActivityText(
        '\u001b[31mrunner_interrupted\u001b[0m sk-abcdefghijklmnopqrstuvwxyz',
      ),
    ).toBe('interrupted sk-***REDACTED***');
  });
});
