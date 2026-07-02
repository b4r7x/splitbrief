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

  it('prettifies recognized shell reads, searches, and listings out of RUN commands', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'command',
        label: "running sed -n '1,240p' CLAUDE.md",
        target: "sed -n '1,240p' CLAUDE.md",
      }),
    ).toMatchObject({ label: 'READ', value: 'CLAUDE.md :1-240', fitMode: 'start' });

    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'unknown',
        label: '/bin/zsh -lc "rg -n deriveLiveStatus src"',
      }),
    ).toMatchObject({ label: 'FIND', value: '"deriveLiveStatus"  src' });

    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'command',
        label: 'running ls src/features',
        target: 'ls src/features',
      }),
    ).toMatchObject({ label: 'LIST', value: 'src/features', fitMode: 'start' });
  });

  it('keeps compound or unrecognized commands as raw RUN', () => {
    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'command',
        label: 'running cat a.ts && cat b.ts',
        target: 'cat a.ts && cat b.ts',
      }),
    ).toMatchObject({ label: 'RUN', value: 'cat a.ts && cat b.ts', fitMode: 'middle' });

    expect(
      runnerActivityLedgerItem({
        stage: 'updated',
        kind: 'command',
        label: 'running wc -l CLAUDE.md',
        target: 'wc -l CLAUDE.md',
      }),
    ).toMatchObject({ label: 'RUN', value: 'wc -l CLAUDE.md' });
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
