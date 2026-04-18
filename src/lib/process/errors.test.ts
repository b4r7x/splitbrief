import { describe, it, expect } from 'vitest';
import { processError } from './errors.js';

describe('processError.notFound', () => {
  it('produces default message from command', () => {
    const err = processError.notFound('codex');
    expect(err.kind).toBe('command-not-found');
    expect(err.message).toBe('Command not found: codex');
    expect(err.data.command).toBe('codex');
  });

  it('uses custom message when provided', () => {
    const err = processError.notFound(
      'codex',
      'Codex CLI not found. Install it with: npm install -g @openai/codex',
    );
    expect(err.message).toBe(
      'Codex CLI not found. Install it with: npm install -g @openai/codex',
    );
    expect(err.data.command).toBe('codex');
  });

  it('is matched by isNotFound', () => {
    expect(processError.isNotFound(processError.notFound('x'))).toBe(true);
  });
});

describe('processError.timeout', () => {
  it('formats with label when provided', () => {
    const err = processError.timeout({
      command: 'x',
      label: 'Codex',
      timeoutMs: 120_000,
      output: 'partial',
    });
    expect(err.kind).toBe('command-timeout');
    expect(err.message).toBe('Codex timed out after 120s');
    expect(err.data.output).toBe('partial');
  });

  it('falls back to command when label is absent', () => {
    const err = processError.timeout({
      command: 'codex',
      timeoutMs: 60_000,
      output: '',
    });
    expect(err.message).toBe('codex timed out after 60s');
  });

  it('is matched by isTimeout', () => {
    const err = processError.timeout({ command: 'x', timeoutMs: 1000, output: '' });
    expect(processError.isTimeout(err)).toBe(true);
  });
});

describe('processError.exitCode', () => {
  it('includes stderr detail when provided', () => {
    const err = processError.exitCode({
      command: 'codex',
      label: 'Codex',
      code: 1,
      stderr: '  boom  ',
    });
    expect(err.kind).toBe('process-output');
    expect(err.message).toBe('Codex exited with code 1: boom');
  });

  it('omits detail when stderr is empty', () => {
    const err = processError.exitCode({
      command: 'codex',
      code: 1,
      stderr: '   ',
    });
    expect(err.message).toBe('codex exited with code 1');
  });

  it('works without label', () => {
    const err = processError.exitCode({ command: 'node', code: 127, stderr: '' });
    expect(err.message).toBe('node exited with code 127');
  });

  it('stores output in data when provided', () => {
    const err = processError.exitCode({
      command: 'node',
      code: 2,
      stderr: 'err',
      output: 'stdout text',
    });
    expect(err.data.output).toBe('stdout text');
  });

  it('is matched by isExitCode', () => {
    const err = processError.exitCode({ command: 'x', code: 1, stderr: '' });
    expect(processError.isExitCode(err)).toBe(true);
  });
});
