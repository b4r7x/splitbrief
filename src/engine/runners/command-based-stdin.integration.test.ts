import { describe, expect, it } from 'vitest';
import { thrownSeatFailure } from '../implementers/pipeline/call-result.js';
import { invokeCommandRunner } from './command-based.js';

// Far past the pipe buffer, so a child that never reads stdin breaks the pipe under the prompt.
const LARGE_PROMPT = 'x'.repeat(256 * 1024);

const failureOf = (script: string): Promise<unknown> =>
  invokeCommandRunner({
    source: {
      kind: 'config',
      runner: { command: 'sh', args: ['-c', script] },
      env: process.env,
      notFoundMessage: 'Shell implementer command not found: sh',
    },
    prompt: LARGE_PROMPT,
    cwd: process.cwd(),
    callContext: { callId: 'call-stdin', role: 'implementer', backendKind: 'shell' },
  }).then(
    () => {
      throw new Error('the runner call resolved');
    },
    (err: unknown) => err,
  );

describe('invokeCommandRunner — a child that stops before it reads its prompt', () => {
  it('fails with its own words, so a usage limit reads as rate-limited', async () => {
    const err = await failureOf(
      'echo "Error: You have hit your usage limit. Your limit resets at 3pm." >&2; exit 1',
    );

    const { words, classification } = thrownSeatFailure(err);
    expect(words).toContain('You have hit your usage limit. Your limit resets at 3pm.');
    expect(classification).toMatchObject({ class: 'rate-limited' });
  });

  it('fails on its exit code with its output when it printed only to stdout', async () => {
    const err = await failureOf('echo "note"; exit 1');

    expect(err).toMatchObject({
      kind: 'process-output',
      message: 'sh exited with code 1',
      data: { code: 1, output: 'note\n' },
    });
  });

  it.each([
    ['says nothing', 'exit 1'],
    ['exits cleanly', 'echo "note" >&2; exit 0'],
  ])('keeps the stdin failure when the child %s', async (_, script) => {
    const err = await failureOf(script);

    expect(err).toMatchObject({
      kind: 'process-stdin-incomplete',
      message: 'Process stdin closed before all input was delivered',
    });
  });
});
