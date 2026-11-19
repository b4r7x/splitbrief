import { describe, expect, it } from 'vitest';
import type { RunnerCallError } from '../calls/types.js';
import { thrownSeatFailure } from '../implementers/pipeline/call-result.js';
import { invokeCommandRunner } from './command-based.js';

// Far past the pipe buffer, so a child that never reads stdin breaks the pipe under the prompt.
const LARGE_PROMPT = 'x'.repeat(256 * 1024);

const failureOf = (script: string, callErrors?: RunnerCallError[]): Promise<unknown> =>
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
    onCallEvent(event) {
      if (event.type === 'call_error') callErrors?.push(event.error);
    },
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

  it('preserves the exit code when the child says nothing', async () => {
    expect(await failureOf('exit 23')).toMatchObject({
      kind: 'process-output',
      message: 'sh exited with code 23',
      data: { code: 23, output: '' },
    });
  });

  it('reports the incomplete prompt followed by stderr when the child exits cleanly', async () => {
    expect(await failureOf('echo "note" >&2; exit 0')).toMatchObject({
      kind: 'prompt-transport-error',
      message: 'Command prompt could not be fully delivered through stdin: note',
      data: { error: { code: 'prompt-transport-error' } },
    });
  });

  it('keeps the opening of a long JSON line in the recorded and thrown transport failures', async () => {
    const callErrors: RunnerCallError[] = [];
    const err = await failureOf(
      `node -e 'require("node:fs").writeSync(2, JSON.stringify({message: "Cannot open the workspace", context: "x".repeat(9000)}) + "\\n")'; exit 0`,
      callErrors,
    );

    expect(err).toMatchObject({
      kind: 'prompt-transport-error',
      message: expect.stringContaining('Cannot open the workspace'),
    });
    expect(callErrors).toEqual([
      expect.objectContaining({
        code: 'prompt-transport-error',
        message: expect.stringContaining('Cannot open the workspace'),
      }),
    ]);
  });
});
