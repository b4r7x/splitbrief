import { awaitActiveWorkflowShutdown } from '../../engine/orchestrator/session-lifecycle/shutdown.js';
import { flushOtel } from '../../lib/otel.js';
import { killAllProcesses } from '../../lib/process/registry.js';
import { restoreTerminalControl } from '../../lib/terminal/control.js';
import { teardownStores } from '../init-stores.js';

const SIGNAL_EXIT_CODE: Record<TerminationSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

type TerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

interface RestoreTerminalOptions {
  fullscreen: boolean;
  mouse?: boolean | undefined;
  paste?: boolean | undefined;
  stdin?: NodeJS.ReadStream | undefined;
}

type CleanupStep = () => void | Promise<void>;

async function runCleanupStep(step: CleanupStep): Promise<void> {
  try {
    await step();
  } catch {
    // Ancillary cleanup is best-effort, but every step must run before cleanup completes.
  }
}

async function cleanupTuiProcess(restore: CleanupStep): Promise<void> {
  await runCleanupStep(teardownStores);
  await killAllProcesses();
  await runCleanupStep(awaitActiveWorkflowShutdown);
  await runCleanupStep(restore);
  await runCleanupStep(flushOtel);
}

export function createTuiCleanup(deps: { restore: CleanupStep }): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= cleanupTuiProcess(deps.restore);
    return pending;
  };
}

// fullscreen-ink restores the main screen buffer only after `waitUntilExit()` resolves, but a
// signal handler that calls `process.exit()` terminates before that async cleanup can run. So
// on a signal during fullscreen we must exit the alternate buffer and unhide the cursor here,
// otherwise the terminal is left on the alternate screen and needs a manual `reset`.
export function restoreTerminal(options: RestoreTerminalOptions): void {
  if (process.stdout.destroyed || process.stdout.writableEnded) return;
  restoreTerminalControl({
    fullscreen: options.fullscreen,
    mouse: options.mouse ?? false,
    paste: options.paste,
    stdin: options.stdin,
  });
}

// Fires when Ctrl+C reaches the OS instead of Ink (a child owns the terminal, so raw
// mode is off) or when an external `kill` arrives. Awaits the shared cleanup once, then exits
// with the conventional 128+signal code.
export function createTerminationHandler(deps: {
  cleanup: () => Promise<void>;
  exit: (code: number) => void;
}): (signal: TerminationSignal) => Promise<void> {
  let pending: Promise<void> | undefined;
  return (signal) => {
    pending ??= (async () => {
      await deps.cleanup();
      deps.exit(SIGNAL_EXIT_CODE[signal]);
    })();
    return pending;
  };
}

// Fires when a crash escapes the render promise chain (uncaughtException or
// unhandledRejection). Awaits the shared cleanup once before the report reaches stderr,
// otherwise the trace prints onto the alternate screen buffer and is lost when the buffer
// is torn down.
export function createCrashHandler(deps: {
  cleanup: () => Promise<void>;
  report: (reason: unknown) => void;
  exit: (code: number) => void;
}): (reason: unknown) => Promise<void> {
  let pending: Promise<void> | undefined;
  return (reason) => {
    pending ??= (async () => {
      await deps.cleanup();
      try {
        deps.report(reason);
      } finally {
        deps.exit(1);
      }
    })();
    return pending;
  };
}

// Fires on Ctrl+Z (job-control suspend). Ink masks SIGTSTP in raw mode, so this only fires when
// a child owns the terminal or an external `kill -TSTP` arrives. Restore the terminal modes the
// suspended shell would otherwise inherit (leave the alternate buffer, unhide the cursor, drop
// mouse/kitty modes), then re-raise the default disposition so the process actually stops.
export function createSuspendHandler(deps: {
  save: () => void;
  raiseDefault: () => void;
}): () => void {
  return () => {
    deps.save();
    deps.raiseDefault();
  };
}

// Fires on SIGCONT after the suspended process is foregrounded again. Re-enters the alternate
// buffer, re-enables input modes, and forces a rerender so the TUI redraws over the shell output.
export function createResumeHandler(deps: { restore: () => void }): () => void {
  return () => {
    deps.restore();
  };
}

// Tracks whether the SIGTSTP listener is currently registered so install/uninstall stays balanced.
// A suspend removes the listener before re-raising the default stop disposition; the matching resume
// re-adds it. A spurious SIGCONT (an external `kill -CONT` on a process that never stopped) must not
// stack a second listener that a later suspend can no longer match, so re-install is a no-op unless
// a prior suspend actually removed it.
export function createSuspendListenerToggle(deps: { install: () => void; uninstall: () => void }): {
  install: () => void;
  uninstall: () => void;
} {
  let installed = false;
  return {
    install: () => {
      if (installed) return;
      installed = true;
      deps.install();
    },
    uninstall: () => {
      if (!installed) return;
      installed = false;
      deps.uninstall();
    },
  };
}
