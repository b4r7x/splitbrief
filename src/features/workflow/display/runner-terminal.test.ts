import { describe, expect, it } from 'vitest';
import {
  cleanRunnerDisplayText,
  runnerActivityDiagnosticPreview,
  runnerActivityDisplay,
  runnerOperationStatusDisplay,
  runnerTerminalOperationLine,
} from './runner-terminal.js';
import type { ActiveOperation } from '../../../stores/workflow/operations.js';

describe('runnerOperationStatusDisplay', () => {
  it('treats aborted runner status as user interruption', () => {
    expect(runnerOperationStatusDisplay('aborted')).toEqual({
      label: 'interrupted',
      marker: '×',
      tone: 'warning',
      showDiagnosticPreview: true,
    });
  });

  it.each([
    ['failed', 'failed'],
    ['timeout', 'timeout'],
    ['truncated', 'truncated'],
    ['refused', 'refused'],
    ['unsupported_tool', 'unsupported tool'],
    ['incomplete', 'incomplete'],
  ] satisfies readonly (readonly [
    Parameters<typeof runnerOperationStatusDisplay>[0],
    string,
  ])[])('keeps %s as an actionable failure', (status, label) => {
    expect(runnerOperationStatusDisplay(status)).toMatchObject({
      label,
      marker: '!',
      tone: 'error',
      showDiagnosticPreview: true,
    });
  });
});

describe('runnerTerminalOperationLine', () => {
  it('preserves terminal suffixes when the failure reason is long', () => {
    const operation: Exclude<ActiveOperation, { status: 'running' }> = {
      callId: 'call-1',
      role: 'implementer',
      phase: 'implementing',
      label: 'implementer implementing',
      status: 'failed',
      startedAt: 1_000,
      endedAt: 2_000,
      durationMs: 1_000,
      partial: true,
      reason:
        'the runner returned a very long failure explanation with a path /tmp/generated/output/that/keeps/going',
      usage: null,
      warnings: ['old warning', 'latest warning detail that should fit if there is room'],
      runnerName: 'codex',
      model: 'gpt-5',
    };

    const text = runnerTerminalOperationLine(operation, 80)
      .map((segment) => segment.text)
      .join('');

    expect(text).toContain('implementer ! failed implementing');
    expect(text).toContain('2 warnings');
    expect(text).toContain('partial output');
    expect(text).toContain('[Codex');
    expect(text.length).toBeLessThan(120);
  });
});

describe('runnerActivityDisplay', () => {
  it('hides internal interruption codes from compact activity', () => {
    expect(
      runnerActivityDisplay({
        stage: 'aborted',
        kind: 'error',
        label: 'aborted runner_interrupted',
        diagnosticPartial: 'cancelled',
      }),
    ).toMatchObject({
      label: 'interrupted',
      value: null,
      diagnosticPreview: 'cancelled',
      marker: '!',
      tone: 'warning',
      valueTone: 'warning',
    });
  });

  it('keeps real terminal failures distinct from interruption', () => {
    expect(
      runnerActivityDisplay({
        stage: 'timeout',
        kind: 'error',
        label: 'timeout command_timeout',
        diagnosticPartial: 'Command timed out',
      }),
    ).toMatchObject({
      label: 'error',
      value: 'timeout command_timeout',
      diagnosticPreview: 'Command timed out',
      marker: 'x',
      tone: 'error',
      valueTone: 'error',
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

describe('cleanRunnerDisplayText', () => {
  it('sanitizes terminal controls, secrets, and internal runner interruption code', () => {
    expect(
      cleanRunnerDisplayText('\u001b[31mrunner_interrupted\u001b[0m sk-abcdefghijklmnopqrstuvwxyz'),
    ).toBe('interrupted sk-***REDACTED***');
  });
});
