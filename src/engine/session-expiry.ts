export const SESSION_EXPIRED_PATTERNS: readonly RegExp[] = [
  /session not found/i,
  /session_not_found/i,
  /invalid session/i,
  /expired session/i,
  /no such session/i,
  /could not resume/i,
];

export function isSessionExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return SESSION_EXPIRED_PATTERNS.some(p => p.test(msg));
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
