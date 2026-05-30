import { toErrorMessage } from '../utils/format-errors.js';

export const SESSION_EXPIRED_PATTERNS: readonly RegExp[] = [
  /session not found/i,
  /session_not_found/i,
  /invalid session/i,
  /expired session/i,
  /no such session/i,
  /could not resume/i,
];

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
  runOnce: (resumeId: string | undefined) => Promise<T>,
  onExpired?: (() => void) | undefined,
): Promise<T> {
  const resumeId = session.getResumeId() ?? undefined;
  try {
    return await runOnce(resumeId);
  } catch (err) {
    if (session.handleResumeError(err)) {
      onExpired?.();
      return await runOnce(undefined);
    }
    throw err;
  }
}
