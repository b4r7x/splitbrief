import { describe, expect, it } from 'vitest';
import { processError } from './errors.js';

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
});
