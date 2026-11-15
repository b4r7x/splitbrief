import { createRunnerCallRecorder } from '../../../calls/recorder/create.js';
import type { RunnerCallRecorder } from '../../../calls/recorder/types.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../../../calls/types.js';
import { credentialValuesFromEnvironment } from '../../sandbox/credential-values.js';
import type { CliInvocation, CliProcessAdapter } from '../contract.js';
import { formatArgumentConflicts, normalizeCliArgumentValidation } from '../validate-args.js';
import { fail, finishFailureSafely } from './failures.js';

type ProcessCliPrelaunch =
  | Readonly<{ ok: true; recorder: RunnerCallRecorder; credentialValues: string[] }>
  | Readonly<{ ok: false; result: RunnerCallResult }>;

/**
 * The steps of a CLI call before its prompt is prepared: the credential values to redact, the
 * recorder that opens the call, and the check of the configured arguments. A failed step is the
 * call's finished result, so no process starts.
 */
export function prelaunchProcessCli(input: {
  adapter: CliProcessAdapter;
  invocation: CliInvocation;
  callContext: RunnerCallContext;
  maxToolCalls: number | undefined;
  onLimit: () => void;
  onEvent: (event: RunnerCallEvent) => void;
}): ProcessCliPrelaunch {
  const { adapter, invocation, callContext } = input;
  let credentialValues: string[];
  try {
    credentialValues = credentialValuesFromEnvironment(
      invocation.environment,
      adapter.descriptor.auth.channels.flatMap((channel) => channel.env),
    );
  } catch {
    const recorder = createRunnerCallRecorder({ context: callContext });
    return {
      ok: false,
      result: finishFailureSafely({
        recorder,
        context: callContext,
        credentialValues: [],
        status: 'failed',
        error: { code: 'callback-failure', message: 'Runner adapter setup failed' },
      }),
    };
  }
  let recorder: RunnerCallRecorder;
  try {
    recorder = createRunnerCallRecorder({
      context: callContext,
      credentialValues,
      stopAfterToolUses: input.maxToolCalls,
      onLimit: input.onLimit,
      onEvent: input.onEvent,
    });
  } catch {
    recorder = createRunnerCallRecorder({ context: callContext, credentialValues });
    return {
      ok: false,
      result: fail({
        recorder,
        status: 'failed',
        error: { code: 'callback-failure', message: 'Runner event callback failed' },
      }),
    };
  }

  const invocationArgs = [...invocation.args];

  let validation: unknown;
  try {
    // An invocation that declares no adapter-owned prefix carries no configured
    // arguments, so the whole argv is the prefix and nothing needs scrutiny.
    validation = adapter.validateArgs({
      invocationArgs,
      baseArgs: invocation.baseArgs ?? invocationArgs,
    });
  } catch {
    return {
      ok: false,
      result: finishFailureSafely({
        recorder,
        context: callContext,
        credentialValues,
        status: 'failed',
        error: { code: 'callback-failure', message: 'CLI argument validation failed' },
      }),
    };
  }

  const normalizedValidation = normalizeCliArgumentValidation(validation);
  if (normalizedValidation === null) {
    return {
      ok: false,
      result: finishFailureSafely({
        recorder,
        context: callContext,
        credentialValues,
        status: 'failed',
        error: {
          code: 'callback-failure',
          message: 'CLI argument validation returned an invalid result',
        },
      }),
    };
  }

  if (!normalizedValidation.valid) {
    return {
      ok: false,
      result: finishFailureSafely({
        recorder,
        context: callContext,
        credentialValues,
        status: 'failed',
        error: {
          code: 'argument-conflict',
          message: `CLI arguments conflict with the adapter contract: ${formatArgumentConflicts(normalizedValidation.conflicts)}`,
        },
      }),
    };
  }

  return { ok: true, recorder, credentialValues };
}
