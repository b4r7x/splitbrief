import { describe, it, expect } from 'vitest';
import { formatCommandError } from './errors.js';

describe('formatCommandError', () => {
  it('not-found: uses bare message when label is absent', () => {
    expect(formatCommandError('not-found', { command: 'codex' })).toBe(
      'Command not found: codex',
    );
  });

  it('not-found: prefixes label when provided', () => {
    expect(formatCommandError('not-found', { command: 'codex', label: 'Codex CLI' })).toBe(
      'Codex CLI: Command not found: codex',
    );
  });

  it('timeout: rounds ms to seconds using label', () => {
    expect(
      formatCommandError('timeout', { command: 'x', label: 'Codex', timeoutMs: 120000 }),
    ).toBe('Codex timed out after 120s');
  });

  it('timeout: falls back to command when label is absent', () => {
    expect(formatCommandError('timeout', { command: 'codex', timeoutMs: 60000 })).toBe(
      'codex timed out after 60s',
    );
  });

  it('exit-code: includes stderr detail when provided', () => {
    expect(
      formatCommandError('exit-code', {
        command: 'codex',
        label: 'Codex',
        code: 1,
        stderr: '  boom  ',
      }),
    ).toBe('Codex exited with code 1: boom');
  });

  it('exit-code: omits detail when stderr is empty', () => {
    expect(
      formatCommandError('exit-code', { command: 'codex', code: 1, stderr: '   ' }),
    ).toBe('codex exited with code 1');
  });

  it('exit-code: works without label', () => {
    expect(formatCommandError('exit-code', { command: 'node', code: 127 })).toBe(
      'node exited with code 127',
    );
  });

  it('spawn-failed: uses label', () => {
    expect(formatCommandError('spawn-failed', { command: 'codex', label: 'Codex' })).toBe(
      'Codex failed to spawn',
    );
  });

  it('spawn-failed: falls back to command', () => {
    expect(formatCommandError('spawn-failed', { command: 'codex' })).toBe(
      'codex failed to spawn',
    );
  });
});
