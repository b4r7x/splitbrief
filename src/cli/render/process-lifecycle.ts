import { awaitActiveWorkflowShutdown } from '../../engine/orchestrator/session-lifecycle/shutdown.js';
import { getDefaultDetectionService } from '../../engine/detection/service/create.js';
import { killAllProcesses } from '../../lib/process/registry.js';
import { restoreTerminalControl } from '../../lib/terminal/control.js';
import { setActiveTerminalHandover } from '../../lib/terminal/editor-handover.js';
import { installDiagnosticSink } from '../../lib/warn.js';
import { preparationStore } from '../../stores/navigation/preparation.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { teardownStores } from '../bootstrap/init.js';
import { SIGNAL_EXIT_CODE, type TerminationSignal } from '../../lib/process/signals.js';
import { closeTuiInput } from './stdin.js';
import type { EditorOutput, TuiInput } from './types.js';

type CleanupStep = () => void | Promise<void>;

interface CleanupFailure {
  error: unknown;
}

async function settleCleanupStep(step: CleanupStep): Promise<CleanupFailure | undefined> {
  try {
    await step();
    return undefined;
  } catch (error) {
    return { error };
  }
}

async function runCleanupStep(step: CleanupStep): Promise<void> {
  // Ancillary cleanup is best-effort, but every step must run before cleanup completes.
  await settleCleanupStep(step);
}

// A process group that survives reaping is reported to the caller, but it must not cost the user
// the remaining owners: the terminal is restored first, then the failure is surfaced.
async function cleanupTuiProcess(restore: CleanupStep): Promise<void> {
  await runCleanupStep(teardownStores);
  await runCleanupStep(() => {
    const current = preparationStore.get();
    if (current.kind !== 'idle') preparationStore.cancel(current.attempt);
  });
  await runCleanupStep(() => getDefaultDetectionService().shutdown());
  const reaping = await settleCleanupStep(killAllProcesses);
  await runCleanupStep(awaitActiveWorkflowShutdown);
  await runCleanupStep(restore);
  if (reaping !== undefined) throw reaping.error;
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
export function restoreTerminal(options: { fullscreen: boolean }): void {
  if (process.stdout.destroyed || process.stdout.writableEnded) return;
  restoreTerminalControl({ fullscreen: options.fullscreen });
}

/**
 * What the terminal cleanup of the TUI reads and changes: the terminal it gives back, and the
 * diagnostics it holds until the terminal is restored.
 */
interface TerminalTeardown {
  fullscreen: boolean;
  input: TuiInput;
  output: EditorOutput;
  tearingDown: boolean;
  deferredDiagnostics: string[];
}

// Every frame Ink writes goes through the output. Ink unmounts on process exit and paints a final
// frame, which after a signal or a crash would land on the restored main screen (a frame as tall
// as the terminal clears it and the scrollback), so the restore closes it first; only the
// keyboard-mode pop of that unmount still reaches the terminal.
function restoreTuiTerminal(teardown: TerminalTeardown, releaseDiagnosticSink: () => void): void {
  try {
    teardown.output.close();
    setActiveTerminalHandover(undefined);
    closeTuiInput(teardown.input);
    restoreTerminal({ fullscreen: teardown.fullscreen });
  } finally {
    releaseDiagnosticSink();
    for (const message of teardown.deferredDiagnostics.splice(0))
      process.stderr.write(`${message}\n`);
  }
}

/** Takes the diagnostics of the TUI and returns the cleanup that gives the terminal back once. */
export function createTerminalCleanup(
  fullscreen: boolean,
  input: TuiInput,
  output: EditorOutput,
): () => Promise<void> {
  const teardown: TerminalTeardown = {
    fullscreen,
    input,
    output,
    tearingDown: false,
    deferredDiagnostics: [],
  };
  // While the TUI owns the terminal a diagnostic that names a presentation goes to the feedback
  // line, never as raw stderr into the frame. An at-exit note, and a feedback diagnostic raised
  // during teardown or rejected, is written after the terminal is restored.
  const releaseDiagnosticSink = installDiagnosticSink((message, presentation) => {
    if (teardown.tearingDown || presentation === 'at-exit') {
      teardown.deferredDiagnostics.push(message);
      return;
    }
    try {
      feedbackStore.setError(message);
    } catch {
      teardown.deferredDiagnostics.push(message);
    }
  });
  const cleanupTui = createTuiCleanup({
    restore: () => restoreTuiTerminal(teardown, releaseDiagnosticSink),
  });
  return () => {
    teardown.tearingDown = true;
    input.selection?.suspend();
    return cleanupTui();
  };
}

// Fires when Ctrl+C reaches the OS instead of Ink (a child owns the terminal, so raw
// mode is off) or when an external `kill` arrives. Awaits the shared cleanup once, then exits
// with the conventional 128+signal code. A cleanup that fails is reported and still exits:
// withholding the exit would leave the user on the alternate screen with a dead Ctrl+C, because
// every later signal receives the same memoized promise.
export function createTerminationHandler(deps: {
  cleanup: () => Promise<void>;
  reportCleanupFailure: (error: unknown) => void;
  exit: (code: number) => void;
}): (signal: TerminationSignal) => Promise<void> {
  let pending: Promise<void> | undefined;
  return (signal) => {
    pending ??= (async () => {
      const failure = await settleCleanupStep(deps.cleanup);
      try {
        if (failure !== undefined) deps.reportCleanupFailure(failure.error);
      } finally {
        deps.exit(SIGNAL_EXIT_CODE[signal]);
      }
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
  reportCleanupFailure: (error: unknown) => void;
  exit: (code: number) => void;
}): (reason: unknown) => Promise<void> {
  let pending: Promise<void> | undefined;
  return (reason) => {
    pending ??= (async () => {
      const failure = await settleCleanupStep(deps.cleanup);
      try {
        if (failure !== undefined) deps.reportCleanupFailure(failure.error);
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

function createSettledProcessListener<T>(deps: {
  handle: (value: T) => Promise<void>;
  reportFailure: (value: T, error: unknown) => void;
}): (value: T) => void {
  return (value) => {
    void deps.handle(value).catch((error: unknown) => {
      try {
        deps.reportFailure(value, error);
      } catch {
        // A process event listener cannot leak a second rejection when stderr is unavailable.
      }
    });
  };
}

export function createTerminationSignalListener(deps: {
  handle: (signal: TerminationSignal) => Promise<void>;
  reportCleanupFailure: (error: unknown) => void;
}): (signal: TerminationSignal) => void {
  return createSettledProcessListener({
    handle: deps.handle,
    reportFailure: (_signal, error) => deps.reportCleanupFailure(error),
  });
}

export function createCrashListener(deps: {
  handle: (reason: unknown) => Promise<void>;
  reportCrash: (reason: unknown) => void;
  reportCleanupFailure: (error: unknown) => void;
}): (reason: unknown) => void {
  return createSettledProcessListener({
    handle: deps.handle,
    reportFailure: (reason, error) => {
      deps.reportCrash(reason);
      deps.reportCleanupFailure(error);
    },
  });
}
