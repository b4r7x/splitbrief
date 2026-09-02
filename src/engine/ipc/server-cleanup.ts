import { rmSync } from 'node:fs';
import { clearActiveReceipt } from '../../core/sessions/active-pointer.js';
import type { rollbackDetachedSessionHandoff } from '../../core/sessions/detached-handoff.js';
import type { rollbackPreparedSession } from '../../core/sessions/prepare.js';
import type { releaseStateAuthority } from '../../core/state/authority.js';
import type { StateAuthorityReceipt } from '../../core/state/types.js';
import { killAllProcesses } from '../../lib/process/registry.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { detachedServerEntryError } from './server-acceptance.js';

export type ServerTermination =
  | { kind: 'exit'; exitCode: number }
  | { kind: 'signal'; signal: string }
  | { kind: 'crash'; cause: string };

export type ServerCleanupOptions = {
  cleanupProcesses: () => Promise<void>;
  stopHeartbeat: () => void;
  closeBridge: () => void;
  closeServer: () => Promise<void>;
  terminalize: (termination: ServerTermination) => Promise<void>;
  flushTelemetry: () => Promise<void>;
  releaseAuthority?: (() => boolean | undefined | Promise<boolean | undefined>) | undefined;
};

type ExitProcess = (code: number) => void;

export function createServerProcessCleanup(): () => Promise<void> {
  let cleanupPromise: Promise<void> | null = null;
  return () => {
    cleanupPromise ??= (async () => {
      await killAllProcesses();
    })();
    return cleanupPromise;
  };
}

// A runner group that survives reaping is reported to the caller, but it must not cost the session
// its terminal state or leave the IPC socket bound: the remaining owners run first, then the
// failure is surfaced.
export function createServerCleanup(
  options: ServerCleanupOptions,
): (termination: ServerTermination) => Promise<void> {
  let cleanupPromise: Promise<void> | null = null;
  return (termination) => {
    if (cleanupPromise !== null) return cleanupPromise;
    options.stopHeartbeat();
    cleanupPromise = (async () => {
      let reaping: { error: unknown } | undefined;
      try {
        await options.cleanupProcesses();
      } catch (cause) {
        reaping = { error: cause };
      }
      options.closeBridge();
      await options.closeServer();
      await options.terminalize(termination);
      if (termination.kind !== 'crash' && options.releaseAuthority !== undefined) {
        await options.releaseAuthority();
      }
      await options.flushTelemetry();
      if (reaping !== undefined) throw reaping.error;
    })();
    return cleanupPromise;
  };
}

export function createServerExitHandlers(options: {
  cleanup: (termination: ServerTermination) => Promise<void>;
  exitProcess?: ExitProcess;
}): {
  signal: (signal: string) => Promise<void>;
  crash: (reason: unknown) => Promise<void>;
} {
  const exitProcess = options.exitProcess ?? process.exit;
  // The process must reach an exit on every termination path: a failed cleanup is reported and
  // exits non-zero. A rejection here would instead be re-entered by the next signal or by the
  // `unhandledRejection` handler — which receives the same memoized rejection — and leave an
  // orphaned server bound to its socket, so even the report cannot throw.
  const exitAfterCleanup = async (termination: ServerTermination, successCode: number) => {
    try {
      await options.cleanup(termination);
    } catch (err) {
      try {
        process.stderr.write(`server-entry: cleanup failed: ${toErrorMessage(err)}\n`);
      } catch {
        // An unwritable stderr must not keep a terminating server alive.
      }
      exitProcess(1);
      return;
    }
    exitProcess(successCode);
  };
  return {
    signal: (signal) => exitAfterCleanup({ kind: 'signal', signal }, 0),
    crash: (reason) => exitAfterCleanup({ kind: 'crash', cause: toErrorMessage(reason) }, 1),
  };
}

export async function cleanupBeforeParentAcceptance(
  input: Readonly<{
    cleanup: (termination: ServerTermination) => Promise<void>;
    rollback: (session: Parameters<typeof rollbackPreparedSession>[0]) => void;
    session: Parameters<typeof rollbackPreparedSession>[0];
    active: Parameters<typeof clearActiveReceipt>[1];
    bootstrapDir: string;
    cause: unknown;
  }>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await input.cleanup({ kind: 'exit', exitCode: 1 });
  } catch (err) {
    failures.push(err);
  }
  try {
    input.rollback(input.session);
  } catch (err) {
    failures.push(err);
    try {
      clearActiveReceipt(input.session.ref, input.active);
    } catch (clearErr) {
      failures.push(clearErr);
    }
  }
  try {
    rmSync(input.bootstrapDir, { recursive: true, force: true });
  } catch (err) {
    failures.push(err);
  }
  if (failures.length > 0) {
    throw detachedServerEntryError.startupCleanup(failures.length, {
      startupCause: input.cause,
      failures,
    });
  }
}

export async function cleanupBeforeServe(
  input: Readonly<{
    rollback: (session: Parameters<typeof rollbackPreparedSession>[0]) => void;
    rollbackHandoff: (session: Parameters<typeof rollbackDetachedSessionHandoff>[0]) => void;
    session: Parameters<typeof rollbackPreparedSession>[0];
    ref: Parameters<typeof releaseStateAuthority>[0];
    receipt: StateAuthorityReceipt | undefined;
    releaseAuthority: typeof releaseStateAuthority;
    stopHeartbeat?: (() => void) | undefined;
    closeBridge?: (() => void) | undefined;
    closeServer?: (() => Promise<void>) | undefined;
    terminalize?: ((termination: ServerTermination) => Promise<void>) | undefined;
    bootstrapDir: string;
    cause: unknown;
  }>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    input.stopHeartbeat?.();
  } catch (err) {
    failures.push(err);
  }
  try {
    input.closeBridge?.();
  } catch (err) {
    failures.push(err);
  }
  try {
    await input.closeServer?.();
  } catch (err) {
    failures.push(err);
  }
  try {
    await input.terminalize?.({ kind: 'exit', exitCode: 1 });
  } catch (err) {
    failures.push(err);
  }
  if (input.receipt !== undefined) {
    try {
      input.releaseAuthority(input.ref, input.receipt);
    } catch (err) {
      failures.push(err);
    }
  }
  try {
    input.rollback(input.session);
  } catch (err) {
    failures.push(err);
    try {
      input.rollbackHandoff(input.session);
    } catch (handoffErr) {
      failures.push(handoffErr);
    }
    try {
      clearActiveReceipt(input.session.ref, input.session.ownership);
    } catch (clearErr) {
      failures.push(clearErr);
    }
  }
  try {
    rmSync(input.bootstrapDir, { recursive: true, force: true });
  } catch (err) {
    failures.push(err);
  }
  if (failures.length > 0) {
    throw detachedServerEntryError.startupCleanup(failures.length, {
      startupCause: input.cause,
      failures,
    });
  }
}
