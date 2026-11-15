import {
  InvocationIdentitySchema,
  type InvocationIdentity,
} from '../../../core/schemas/invocation-identity.js';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text/diagnostic.js';
import { error } from '../../../utils/error.js';
import { isRecord } from '../../../utils/type-guards.js';
import { createRunnerCallDeltaLimiter } from '../output-limit.js';
import {
  RUNNER_CALL_PROVIDER_TYPE_MAX_LENGTH,
  RUNNER_CALL_RAW_TAIL_MAX_LENGTH,
} from '../schema.js';
import { createRunnerCallCredentialRedactor } from '../status.js';
import type {
  RunnerCallEvent,
  RunnerCallContext,
  RunnerCallEventInput,
  RunnerCallResult,
} from '../types.js';
import { formatZodIssues } from '../unknown-upstream.js';

/**
 * Streamed text is what grows without end: past the retained bound it drops
 * from the middle of the call. A final text replaces what streamed before it,
 * so it stays, like every other event.
 */
export function streamedTextBytes(event: RunnerCallEvent): number | null {
  return event.type === 'call_text_delta' && event.semantics !== 'final' ? event.text.length : null;
}

// The identity is fixed before `call_started`: every event and result of the
// call carries this one frozen copy, whatever the producer does with its own.
export function snapshotRunnerCallContext(context: RunnerCallContext): RunnerCallContext {
  context = {
    ...context,
    ...(context.axes !== undefined && { axes: Object.freeze([...context.axes]) }),
  };
  if (context.invocationIdentity === undefined) return context;
  const parsed = InvocationIdentitySchema.safeParse(context.invocationIdentity);
  if (!parsed.success) {
    throw error('runner-call-identity-invalid', 'Runner call invocation identity is invalid', {
      callId: context.callId,
      issues: formatZodIssues(parsed.error.issues),
    });
  }
  return { ...context, invocationIdentity: freezeInvocationIdentity(parsed.data) };
}

function freezeInvocationIdentity(identity: InvocationIdentity): InvocationIdentity {
  for (const value of Object.values(identity)) {
    if (typeof value === 'object') Object.freeze(value);
  }
  return Object.freeze(identity);
}

export function nowOrTimestamp(input: RunnerCallEventInput): number {
  if (
    isRecord(input) &&
    typeof input.ts === 'number' &&
    Number.isInteger(input.ts) &&
    input.ts >= 0
  ) {
    return input.ts;
  }
  return Date.now();
}

export function recordType(input: RunnerCallEventInput): unknown {
  return isRecord(input) ? input.type : undefined;
}

export function metadataString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = sanitizeTerminalDiagnosticText(value, { maxChars: 256 }).trim();
  return clean.length > 0 ? clean : undefined;
}

export function boundedRunnerCallProviderType(value: string): string {
  return value.length <= RUNNER_CALL_PROVIDER_TYPE_MAX_LENGTH
    ? value
    : value.slice(0, RUNNER_CALL_PROVIDER_TYPE_MAX_LENGTH);
}

export function runnerCallRawTail(
  message: string,
  credentialValues: readonly string[] = [],
): string | undefined {
  const firstLine = message.split('\n', 1)[0] ?? '';
  const redacted = createRunnerCallCredentialRedactor(credentialValues)(firstLine);
  const clean = sanitizeTerminalDiagnosticText(redacted, {
    maxChars: RUNNER_CALL_RAW_TAIL_MAX_LENGTH,
  }).trim();
  return clean.length > 0 ? clean : undefined;
}

export function createTextLimiter(): ReturnType<typeof createRunnerCallDeltaLimiter> {
  return createRunnerCallDeltaLimiter({
    code: 'runner_call_text_limit',
    label: 'The reply',
  });
}

export function hasPartialResult(result: RunnerCallResult): boolean {
  return result.text.length > 0 || result.warnings.length > 0 || result.toolUses.length > 0;
}
