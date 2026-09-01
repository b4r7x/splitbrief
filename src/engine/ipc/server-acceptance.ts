import { canSignalProcess } from '../../lib/process/liveness.js';
import type { SessionOwnershipReceipt } from '../../core/sessions/active-pointer.js';
import type {
  StateAuthorityAcquisitionResult,
  StateAuthorityReceipt,
} from '../../core/state/types.js';
import { error } from '../../utils/error.js';

type ParentAcceptance = Readonly<{
  version: 1;
  sessionId: string;
  generation: string;
  childPid: number;
}>;

export const detachedServerEntryError = {
  parentExited: (parentPid: number) =>
    error('detached-parent-exited', 'Detached parent exited before accepting startup.', {
      parentPid,
    }),
  parentAcceptanceTimeout: (timeoutMs: number) =>
    error(
      'detached-parent-acceptance-timeout',
      'Timed out waiting for detached parent acceptance.',
      { timeoutMs },
    ),
  authorityUnavailable: (kind: StateAuthorityAcquisitionResult['kind']) =>
    error(
      'detached-state-authority-unavailable',
      `Detached startup requires a usable state authority; acquisition returned ${kind}.`,
      { kind },
    ),
  authorityHydration: (kind: string) =>
    error(
      'detached-state-authority-hydration-failed',
      `Detached startup could not hydrate the owner state (${kind}).`,
      { kind },
    ),
  startupCleanup: (failureCount: number, cause: unknown) =>
    error(
      'detached-startup-cleanup-failed',
      `Detached startup cleanup failed in ${failureCount} step${failureCount === 1 ? '' : 's'}.`,
      { failureCount },
      cause,
    ),
} as const;

export function createParentAcceptanceBarrier(
  input: Readonly<{
    candidate: SessionOwnershipReceipt;
    authority?: StateAuthorityReceipt | undefined;
    assertAuthority?: (() => void) | undefined;
    parentPid: number;
    childPid: number;
    timeoutMs: number;
    acceptHandoff: () => boolean;
    settleHandoff: () => 'accepted' | 'rolled-back';
  }>,
): Readonly<{
  accept: (acceptance: ParentAcceptance) => boolean;
  wait: () => Promise<void>;
}> {
  let accepted = false;
  let closed = false;
  const acceptanceDeadline = Date.now() + input.timeoutMs;
  let handoffDeadline = acceptanceDeadline;
  let waitPromise: Promise<void> | undefined;

  return {
    accept: (acceptance) => {
      if (
        closed ||
        accepted ||
        Date.now() >= acceptanceDeadline ||
        acceptance.version !== input.candidate.version ||
        acceptance.sessionId !== input.candidate.sessionId ||
        acceptance.generation !== input.candidate.generation ||
        acceptance.childPid !== input.childPid
      ) {
        return false;
      }
      if (input.assertAuthority !== undefined) {
        try {
          input.assertAuthority();
        } catch {
          return false;
        }
      }
      accepted = true;
      handoffDeadline = Date.now() + input.timeoutMs;
      return true;
    },
    wait: () => {
      waitPromise ??= new Promise<void>((resolve, reject) => {
        const succeed = () => {
          closed = true;
          resolve();
        };
        const fail = (cause: unknown) => {
          closed = true;
          reject(cause);
        };
        const poll = () => {
          const parentAlive = canSignalProcess(input.parentPid);
          const now = Date.now();
          if (accepted) {
            try {
              input.assertAuthority?.();
              if (input.acceptHandoff()) {
                succeed();
                return;
              }
              if (!parentAlive || now >= handoffDeadline) {
                if (input.settleHandoff() === 'accepted') {
                  succeed();
                  return;
                }
                fail(
                  parentAlive
                    ? detachedServerEntryError.parentAcceptanceTimeout(input.timeoutMs)
                    : detachedServerEntryError.parentExited(input.parentPid),
                );
                return;
              }
            } catch (cause) {
              fail(cause);
              return;
            }
          } else {
            if (!parentAlive) {
              fail(detachedServerEntryError.parentExited(input.parentPid));
              return;
            }
            if (now >= acceptanceDeadline) {
              fail(detachedServerEntryError.parentAcceptanceTimeout(input.timeoutMs));
              return;
            }
          }
          setTimeout(poll, 100);
        };
        poll();
      });
      return waitPromise;
    },
  };
}
