import { toErrorMessage } from '../utils/format-errors.js';
import type { RunnerCallContext } from './calls/types.js';

export const SESSION_EXPIRED_PATTERNS: readonly RegExp[] = [
  /session not found/i,
  /session_not_found/i,
  /invalid session/i,
  /expired session/i,
  /no such session/i,
  /could not resume/i,
];

const CALL_ID_MAX_LENGTH = 128;

export function isSessionExpiredError(err: unknown): boolean {
  const msg = toErrorMessage(err);
  return SESSION_EXPIRED_PATTERNS.some((p) => p.test(msg));
}

export interface SessionResumeState {
  getResumeId(): string | null;
  capture(id: string | null): void;
  handleResumeError(err: unknown): boolean;
}

export function createSessionResumeState(
  opts: { onExpired?: ((expiredId: string) => void) | undefined } = {},
): SessionResumeState {
  let currentSessionId: string | null = null;

  return {
    getResumeId(): string | null {
      return currentSessionId;
    },
    capture(id: string | null): void {
      currentSessionId = id;
    },
    handleResumeError(err: unknown): boolean {
      if (!currentSessionId || !isSessionExpiredError(err)) return false;
      const expiredId = currentSessionId;
      currentSessionId = null;
      opts.onExpired?.(expiredId);
      return true;
    },
  };
}

export async function runWithResumeFallback<T>(
  session: SessionResumeState,
  runOnce: (resumeId: string | undefined, attempt: number) => Promise<T>,
  onExpired?: (() => void) | undefined,
): Promise<T> {
  const resumeId = session.getResumeId() ?? undefined;
  try {
    return await runOnce(resumeId, 1);
  } catch (err) {
    if (session.handleResumeError(err)) {
      onExpired?.();
      return await runOnce(undefined, 2);
    }
    throw err;
  }
}

export function createSessionAttemptCallContext(
  context: RunnerCallContext,
  attempt: number,
): RunnerCallContext {
  const suffix = `-attempt-${attempt}`;
  const callId =
    context.callId.length + suffix.length <= CALL_ID_MAX_LENGTH
      ? `${context.callId}${suffix}`
      : `${context.callId.slice(0, CALL_ID_MAX_LENGTH - suffix.length)}${suffix}`;
  return { ...context, callId, attempt };
}
