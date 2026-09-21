import { describe, expect, it } from 'vitest';
import { normalizeClaudeProcessOutputError } from './child-env.js';

describe('normalizeClaudeProcessOutputError', () => {
  it('turns a fatal spawn signal into an error that carries its remediation', () => {
    const err = normalizeClaudeProcessOutputError(
      {
        state: 'output-budget-breach',
        remediation: 'stdout exceeded its 1048576-byte output budget.',
      },
      undefined,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      kind: 'output-budget-breach',
      message: 'stdout exceeded its 1048576-byte output budget.',
    });
  });

  it('falls back to the default remediation when the signal carries none', () => {
    const err = normalizeClaudeProcessOutputError(
      { state: 'output-budget-breach', remediation: '' },
      undefined,
    );

    expect(err).toMatchObject({
      kind: 'output-budget-breach',
      message:
        'The tool wrote more than 64 MB of output and was stopped. Narrow what it was asked to print, then retry.',
    });
  });

  it('leaves other errors untouched', () => {
    const cause = new Error('boom');

    expect(normalizeClaudeProcessOutputError(cause, undefined)).toBe(cause);
  });
});
