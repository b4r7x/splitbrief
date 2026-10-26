import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createImplementerCallContext, thrownSeatFailure } from './call-result.js';
import { requireCompletedCall } from '../../planners/require-completed-call.js';
import {
  opencodePlannerAdapter,
  opencodeProtocolEvents,
} from '../../runners/cli-tools/opencode.js';
import type { RunnerCallResult } from '../../calls/types.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
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

describe('thrownSeatFailure on a failed planner or reviewer call', () => {
  // Captured live from `opencode run --format json` (2.0.32, 2026-10-26) with a revoked provider credential.
  const providerAuth = readFileSync(
    join(import.meta.dirname, '../../../../testing/fixtures/opencode/provider-auth-401.ndjson'),
    'utf8',
  ).trim();

  function thrownBy(result: RunnerCallResult): unknown {
    try {
      requireCompletedCall(result);
    } catch (err) {
      return err;
    }
    throw new Error('the call did not fail');
  }

  it('reads the recorded OpenCode 401 as a sign-out, as the BUILD seat does', () => {
    const terminal = opencodePlannerAdapter.terminal({
      outputContract: opencodePlannerAdapter.outputContract,
      events: opencodeProtocolEvents(providerAuth),
      stderr: '',
      exitCode: 1,
      signal: null,
    });
    if (terminal.status === 'completed') throw new Error('the replay completed');

    const failure = thrownSeatFailure(
      thrownBy(
        makeRunnerCallResult({
          status: 'failed',
          role: 'review',
          text: '',
          error: terminal.error,
          backendKind: 'cli',
        }),
      ),
    );

    expect(failure.classification).toEqual({ class: 'account', cause: 'auth' });
    expect(failure.words).toContain('Invalid credential');
  });

  it('reads the HTTP status the failed call carries, not the call status', () => {
    const failure = thrownSeatFailure(
      thrownBy(
        makeRunnerCallResult({
          status: 'failed',
          role: 'review',
          text: '',
          error: { code: 'opencode-error', message: 'Upstream request failed', status: 401 },
          backendKind: 'cli',
        }),
      ),
    );

    expect(failure.classification).toEqual({ class: 'account', cause: 'auth' });
  });

  it('reads the provider type the failed call carries', () => {
    const failure = thrownSeatFailure(
      thrownBy(
        makeRunnerCallResult({
          status: 'failed',
          role: 'planner',
          text: '',
          error: {
            code: 'opencode-error',
            message: 'Upstream request failed',
            providerType: 'provider.quota',
          },
          backendKind: 'cli',
        }),
      ),
    );

    expect(failure.classification).toEqual({ class: 'account', cause: 'quota' });
  });
});
