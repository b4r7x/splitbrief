import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_DIAGNOSTIC_MAX_CHARS } from '../../utils/display-text.js';
import { processError } from './errors.js';

const JWT_FIXTURE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('processError.notFound', () => {
  it.each([
    {
      command: 'codex',
      message: undefined,
      expected: 'Command not found: codex',
    },
    {
      command: 'codex',
      message: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
      expected: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
    },
  ])('formats command-not-found errors for $command', ({ command, message, expected }) => {
    const err = processError.notFound(command, message);

    expect(err).toMatchObject({
      kind: 'command-not-found',
      message: expected,
      data: { command },
    });
    expect(processError.isNotFound(err)).toBe(true);
  });

  it('sanitizes terminal-unsafe command payloads', () => {
    const err = processError.notFound(`\u001b]0;owned\u0007cmd-${JWT_FIXTURE}`);

    expect(err.message).toBe('Command not found: cmd-***REDACTED***');
    expect(err.data.command).toBe('cmd-***REDACTED***');
  });
});

describe('processError.timeout', () => {
  it.each([
    {
      opts: { command: 'x', label: 'Codex', timeoutMs: 120_000, output: 'partial' },
      expected: 'Codex timed out after 120s',
    },
    {
      opts: { command: 'codex', timeoutMs: 60_000, output: '' },
      expected: 'codex timed out after 60s',
    },
  ])('formats timeout errors with the visible process label', ({ opts, expected }) => {
    const err = processError.timeout(opts);

    expect(err).toMatchObject({
      kind: 'command-timeout',
      message: expected,
      data: opts,
    });
    expect(processError.isTimeout(err)).toBe(true);
  });

  it('sanitizes timeout message and payload command fields', () => {
    const err = processError.timeout({
      command: `cmd-${JWT_FIXTURE}`,
      label: `\u001b]0;owned\u0007label-${JWT_FIXTURE}`,
      timeoutMs: 1000,
      output: `out-${JWT_FIXTURE}`,
    });

    expect(err.message).toBe('label-***REDACTED*** timed out after 1s');
    expect(err.data).toMatchObject({
      command: 'cmd-***REDACTED***',
      label: 'label-***REDACTED***',
      output: 'out-***REDACTED***',
    });
  });
});

describe('processError.idleTimeout', () => {
  it('idleTimeout builds a command-idle-timeout error with seconds in the message', () => {
    const err = processError.idleTimeout({ command: 'codex', label: 'Codex', idleMs: 90_000 });

    expect(err).toMatchObject({
      kind: 'command-idle-timeout',
      message: 'Codex produced no output for 90s and was terminated',
      data: { command: 'codex', label: 'Codex', idleMs: 90_000 },
    });
    expect(processError.isIdleTimeout(err)).toBe(true);
  });

  it('falls back to the command when no label is given', () => {
    const err = processError.idleTimeout({ command: 'codex', idleMs: 60_000 });

    expect(err.message).toBe('codex produced no output for 60s and was terminated');
  });

  it('sanitizes idle timeout command and label payloads', () => {
    const err = processError.idleTimeout({
      command: `cmd-${JWT_FIXTURE}`,
      label: `\u001b]0;owned\u0007label-${JWT_FIXTURE}`,
      idleMs: 1000,
    });

    expect(err.message).toBe('label-***REDACTED*** produced no output for 1s and was terminated');
    expect(err.data).toMatchObject({
      command: 'cmd-***REDACTED***',
      label: 'label-***REDACTED***',
    });
  });
});

describe('processError.exitCode', () => {
  it.each([
    {
      opts: { command: 'codex', label: 'Codex', code: 1, stderr: '  boom  ' },
      expected: 'Codex exited with code 1: boom',
    },
    {
      opts: { command: 'codex', code: 1, stderr: '   ' },
      expected: 'codex exited with code 1',
    },
    {
      opts: { command: 'node', code: 127, stderr: '' },
      expected: 'node exited with code 127',
    },
    {
      opts: { command: 'claude', code: 1, stderr: '', detail: 'Invalid API key' },
      expected: 'claude exited with code 1: Invalid API key',
    },
    {
      opts: { command: 'claude', code: 1, stderr: 'real stderr', detail: 'ignored fallback' },
      expected: 'claude exited with code 1: real stderr',
    },
  ])('formats process-output errors for non-zero exits', ({ opts, expected }) => {
    const err = processError.exitCode(opts);

    expect(err.kind).toBe('process-output');
    expect(err.message).toBe(expected);
    expect(processError.isExitCode(err)).toBe(true);
  });

  it('redacts and stores output detail for process failures', () => {
    const err = processError.exitCode({
      command: 'node',
      code: 2,
      stderr: 'err',
      output: 'stdout text',
    });

    expect(err.data.output).toBe('stdout text');
  });

  it('falls back to detail for output when stderr and output are empty', () => {
    const err = processError.exitCode({
      command: 'claude',
      code: 1,
      stderr: '',
      detail: 'Credit balance is too low',
    });

    expect(err.data.output).toBe('Credit balance is too low');
  });

  it('sanitizes and bounds terminal-unsafe failure payloads', () => {
    const err = processError.exitCode({
      command: 'node',
      code: 1,
      stderr: `\u001b]0;owned\u0007token=${JWT_FIXTURE} \u001b[31mred\u001b[0m`,
      output: `key=sk-abcdefghijklmnopqrstuvwxyz ${'x'.repeat(
        DEFAULT_TERMINAL_DIAGNOSTIC_MAX_CHARS + 10,
      )}`,
    });

    expect(err.message).toBe('node exited with code 1: token=***REDACTED*** red');
    expect(err.data.stderr).toBe('token=***REDACTED*** red');
    expect(err.data.output).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(err.data.output).toHaveLength(DEFAULT_TERMINAL_DIAGNOSTIC_MAX_CHARS);
    expect(err.data.output.endsWith('…')).toBe(true);
  });

  it('sanitizes process-output command and label payloads', () => {
    const err = processError.exitCode({
      command: `cmd-${JWT_FIXTURE}`,
      label: `\u001b]0;owned\u0007label-${JWT_FIXTURE}`,
      code: 1,
      stderr: '',
    });

    expect(err.message).toBe('label-***REDACTED*** exited with code 1');
    expect(err.data.command).toBe('cmd-***REDACTED***');
    expect(err.data.label).toBe('label-***REDACTED***');
  });
});
