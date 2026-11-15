import { describe, expect, it } from 'vitest';
import { RUNNER_CALL_STDERR_MAX_BYTES } from './output-limit.js';
import {
  appendStderrPreview,
  stderrDiagnosticWarning,
  stderrLooksWarningLike,
} from './stderr-diagnostics.js';

describe('stderrLooksWarningLike', () => {
  it.each([
    'error: no such file',
    'build FAILED',
    'a failure in the cache',
    'fatal: bad ref',
    'Exception in thread main',
    'warning: low disk',
    'warn: low disk',
    'the flag is deprecated',
  ])('reads %j as a warning', (text) => {
    expect(stderrLooksWarningLike(text)).toBe(true);
  });

  it.each(['background progress', 'warned once', 'errors.log written', ''])(
    'reads %j as plain text',
    (text) => {
      expect(stderrLooksWarningLike(text)).toBe(false);
    },
  );
});

describe('stderrDiagnosticWarning', () => {
  it('gives a stderr warning on the status surface with a clean message', () => {
    expect(
      stderrDiagnosticWarning('stderr_diagnostic', 'fatal: \u001b[31mbad\u001b[0m ref'),
    ).toEqual({
      code: 'stderr_diagnostic',
      severity: 'warning',
      source: 'stderr',
      surface: 'status',
      channel: 'stderr',
      message: 'fatal: bad ref',
    });
  });
});

describe('appendStderrPreview', () => {
  it('keeps each stderr chunk apart from the next', () => {
    expect(appendStderrPreview(appendStderrPreview('', 'disk full'), 'retrying')).toBe(
      'disk full retrying ',
    );
  });

  it('cuts the preview at the stderr bound', () => {
    const preview = appendStderrPreview('', 'x'.repeat(RUNNER_CALL_STDERR_MAX_BYTES + 10));

    expect(preview).toHaveLength(RUNNER_CALL_STDERR_MAX_BYTES);
    expect(preview.endsWith('…')).toBe(true);
  });
});
