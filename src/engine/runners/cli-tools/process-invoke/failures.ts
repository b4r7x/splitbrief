import {
  type HaltKind,
  HALT_SIGNATURES,
  classifyHaltSignature,
} from '../../../../core/pipeline-spec/halts.js';
import { error } from '../../../../utils/error.js';
import { assertNever, isRecord } from '../../../../utils/type-guards.js';
import { createRunnerCallRecorder } from '../../../calls/recorder/create.js';
import type { RunnerCallRecorder } from '../../../calls/recorder/types.js';
import type {
  RunnerCallContext,
  RunnerCallResult,
  RunnerCallFailureStatus,
} from '../../../calls/types.js';
import { classifySeatFailure } from '../../seat-failure/classify.js';
import type { CliOutputContract } from '../contract.js';

/**
 * A halt phrase in the words of a failed CLI run outranks the bare exit code:
 * the ladder must not spend retries on a signed-out, out-of-quota, unknown-model
 * or malformed-recipe process. The matched line is the diagnostic, so the user
 * reads the tool's own words.
 */
export const HALT_FAILURES: Readonly<
  Record<HaltKind, { code: string; phrases: readonly string[] }>
> = {
  'input-too-large': { code: 'input-too-large', phrases: HALT_SIGNATURES.inputTooLarge },
  auth: { code: 'unauthenticated', phrases: HALT_SIGNATURES.auth },
  usage: { code: 'usage-limit', phrases: HALT_SIGNATURES.usage },
  'missing-model': { code: 'missing-model', phrases: HALT_SIGNATURES.missingModel },
  spawn: { code: 'implementer-recipe-invalid', phrases: HALT_SIGNATURES.spawnFailure },
};

export type StderrHaltCode = 'usage-limit' | 'unauthenticated';

/**
 * The diagnosis of a failed CLI call. The last line the tool printed on stdout can be the model's
 * prose, where a path under `billing/` or a shelled-out `permission denied` is task output, so it
 * matches only the halt phrases. Stderr is the tool's diagnostic channel: when it names no halt
 * phrase, the seat failure classifier reads all of it, and an account refusal or a limit keeps the
 * whole diagnostic as the words the halt quotes. A code recognized early is a fallback if later
 * output moves the diagnostic out of the classifier's match.
 */
export function haltFailure(
  stderr: string,
  stdoutTail: readonly string[] = [],
  recognizedCode?: StderrHaltCode,
): { code: string; message: string } | null {
  const lines = [...stderr.split('\n'), ...stdoutTail];
  const kind = classifyHaltSignature(lines);
  if (kind !== null) {
    const { code, phrases } = HALT_FAILURES[kind];
    const matched = lines.find((line) =>
      phrases.some((phrase) => line.toLowerCase().includes(phrase)),
    );
    return { code, message: matched?.trim() ?? code };
  }
  const diagnostic = stderr.trim();
  if (diagnostic.length === 0) return null;
  const seat = classifySeatFailure({ message: diagnostic, source: 'stderr' });
  if (seat.class === 'account') {
    return { code: seat.cause === 'auth' ? 'unauthenticated' : 'usage-limit', message: diagnostic };
  }
  if (seat.class === 'rate-limited') return { code: 'usage-limit', message: diagnostic };
  return recognizedCode === undefined ? null : { code: recognizedCode, message: diagnostic };
}

const HALT_CODES: ReadonlySet<string> = new Set(
  Object.values(HALT_FAILURES).map((failure) => failure.code),
);

/** A failed terminal whose own words already name a halt keeps them over anything on stderr. */
export function namesHalt(
  failure: Readonly<{
    code: string;
    message: string;
    status?: number | undefined;
    providerType?: string | undefined;
  }>,
): boolean {
  return (
    HALT_CODES.has(failure.code) ||
    classifyHaltSignature([failure.message]) !== null ||
    classifySeatFailure({
      message: failure.message,
      ...(failure.status !== undefined && { status: failure.status }),
      ...(failure.providerType !== undefined && { providerType: failure.providerType }),
      source: 'result-error',
    }).class !== 'other'
  );
}

export function callbackFailure(
  context: RunnerCallContext,
  credentialValues: readonly string[],
): RunnerCallResult {
  return fail({
    recorder: createRunnerCallRecorder({ context, credentialValues }),
    status: 'failed',
    error: { code: 'callback-failure', message: 'Runner event callback failed' },
  });
}

export function finishFailureSafely(input: {
  recorder: RunnerCallRecorder;
  context: RunnerCallContext;
  credentialValues: readonly string[];
  status: RunnerCallFailureStatus;
  error: { code: string; message: string };
}): RunnerCallResult {
  const { recorder, context, credentialValues, status, error: failure } = input;
  try {
    return fail({ recorder, status, error: failure });
  } catch {
    // Consumer callbacks are untrusted code. If one throws while the terminal failure is being
    // emitted, finish through a recorder without that callback rather than leaking a raw throw.
    return fail({
      recorder: createRunnerCallRecorder({ context, credentialValues }),
      status,
      error: failure,
    });
  }
}

export function fail(input: {
  recorder: RunnerCallRecorder;
  status: RunnerCallFailureStatus;
  error: { code: string; message: string };
}): RunnerCallResult {
  return input.recorder.finishFailed({ status: input.status, error: input.error });
}

export function isFailureExit(contract: CliOutputContract, exitCode: number | null): boolean {
  switch (contract.kind) {
    case 'text-exit':
      return !contract.successfulExitCodes.includes(exitCode ?? -1);
    case 'structured-terminal':
      return exitCode !== 0;
    default:
      return assertNever(contract);
  }
}

export function fatal(message: string): Error {
  const cause = error('protocol-failure', message);
  Object.assign(cause, { state: 'protocol-failure', remediation: message });
  return cause;
}

export function fatalSignal(cause: unknown): {
  state: 'protocol-failure' | 'callback-failure';
  remediation: string;
} {
  return { state: fatalStateOf(cause) ?? 'protocol-failure', remediation: errorMessage(cause) };
}

export function fatalStateOf(cause: unknown): 'protocol-failure' | 'callback-failure' | null {
  if (!isRecord(cause)) return null;
  const state = cause.state;
  if (state === 'protocol-failure' || state === 'callback-failure') {
    return state;
  }
  return null;
}

export function prelaunchErrorCode(
  cause: unknown,
): 'callback-failure' | 'prompt-transport-error' | 'steering-transport-error' {
  if (isRecord(cause) && cause.kind === 'steering-transport-error') return cause.kind;
  return isRecord(cause) && cause.kind === 'prompt-transport-error'
    ? 'prompt-transport-error'
    : 'callback-failure';
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (isRecord(cause) && typeof cause.remediation === 'string') {
    return cause.remediation;
  }
  return 'CLI process invocation failed';
}

export function prelaunchErrorMessage(cause: unknown): string {
  if (
    isRecord(cause) &&
    cause.kind === 'steering-transport-error' &&
    typeof cause.message === 'string'
  ) {
    return cause.message;
  }
  if (isRecord(cause) && cause.kind === 'prompt-transport-error') {
    return typeof cause.message === 'string'
      ? cause.message
      : 'CLI prompt transport failed before launch';
  }
  return 'CLI pre-launch validation failed';
}
