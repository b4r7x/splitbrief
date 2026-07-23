import { restoreTerminalControl } from '../../lib/terminal/control.js';

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
// mode is off) or when an external `kill` arrives. Runs once: restores the terminal,
// reaps orphaned children, then exits with the conventional 128+signal code.
export function createTerminationHandler(deps: {
  cleanup: () => void;
  exit: (code: number) => void;
}): (signal: TerminationSignal) => void {
  let handled = false;
  return (signal) => {
    if (handled) return;
    handled = true;
    try {
      deps.cleanup();
    } catch {
      // signal shutdown must still exit even when terminal cleanup races a closed TTY
    }
    deps.exit(SIGNAL_EXIT_CODE[signal]);
  };
}

// Fires when a crash escapes the render promise chain (uncaughtException or
// unhandledRejection). Runs once: restores the terminal and reaps orphaned children
// before the report reaches stderr, otherwise the trace prints onto the alternate
// screen buffer and is lost when the buffer is torn down.
export function createCrashHandler(deps: {
  cleanup: () => void;
  report: (reason: unknown) => void;
  exit: (code: number) => void;
}): (reason: unknown) => void {
  let handled = false;
  return (reason) => {
    if (handled) return;
    handled = true;
    try {
      deps.cleanup();
    } catch {
      // crash shutdown must still report and exit even when terminal cleanup races a closed TTY
    }
    deps.report(reason);
    deps.exit(1);
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
