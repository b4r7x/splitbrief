import { describe, expect, it } from 'vitest';
import { createImplementerCallContext, thrownSeatFailure } from './call-result.js';
import { processError } from '../../../lib/process/errors.js';
import { error } from '../../../utils/error.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

describe('createImplementerCallContext', () => {
  it('records the axis words of the build seat the call runs on', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    });

    const context = createImplementerCallContext({ config, attempt: 1, taskId: taskId('T001') });

    expect(context).toMatchObject({ runnerName: 'codex', model: 'gpt-6.1-sol', axes: ['high'] });
  });
});

describe('thrownSeatFailure', () => {
  const LIMIT_LINE = "Error: You've hit your usage limit. Your limit resets at 3pm.";
  const exited = (streams: Readonly<{ stderr?: string; stdout?: string }>) =>
    processError.exitCode({
      command: 'sh',
      code: 1,
      stderr: streams.stderr ?? '',
      output: streams.stdout ?? '',
    });

  it('reads a limit on stderr from the message', () => {
    const failure = thrownSeatFailure(exited({ stderr: LIMIT_LINE, stdout: 'done\n' }));

    expect(failure).toMatchObject({
      words: `sh exited with code 1: ${LIMIT_LINE}`,
      classification: { class: 'rate-limited' },
      source: 'thrown',
    });
  });

  it('reads a limit on the last stdout line past unrelated stderr', () => {
    const failure = thrownSeatFailure(
      exited({ stderr: 'warning: deprecated flag', stdout: `working…\n${LIMIT_LINE}\n\n` }),
    );

    expect(failure).toMatchObject({
      words: LIMIT_LINE,
      classification: { class: 'rate-limited' },
      source: 'stdout-tail',
    });
  });

  it('reads a sign-in refusal on the last stdout line as an account refusal', () => {
    const failure = thrownSeatFailure(exited({ stdout: 'Not logged in · Please run /login\n' }));

    expect(failure.classification).toEqual({ class: 'account', cause: 'auth' });
  });

  it.each([
    ['a limit phrase above an ordinary last line', `${LIMIT_LINE}\ndone\n`],
    ['a last line of prose that names a limit', 'The file is within the size limit\n'],
    ['a balance phrase only the thrown words may name', 'insufficient balance\n'],
  ])('keeps the exit on %s', (_, stdout) => {
    const failure = thrownSeatFailure(exited({ stdout }));

    expect(failure).toMatchObject({
      words: 'sh exited with code 1',
      classification: { class: 'other' },
      source: 'thrown',
    });
  });

  it('reads the status an API error carries', () => {
    const failure = thrownSeatFailure(
      error('api-error', 'Provider rejected the request', { status: 429, detail: 'slow down' }),
    );

    expect(failure).toMatchObject({ words: 'slow down', source: 'thrown' });
    expect(failure.classification.class).toBe('account');
  });
});
