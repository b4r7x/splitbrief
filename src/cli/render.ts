import { render } from 'ink';
import { withFullScreen } from 'fullscreen-ink';
import type { createElement } from 'react';
import { warnError } from '../lib/warn.js';
import {
  createFilteredStdin,
  type FilteredStdin,
  setActiveFilteredStdin,
} from '../lib/terminal/filtered-stdin.js';
import { detectKittyKeyboardFlags } from '../lib/terminal/kitty-keyboard.js';
import {
  configureDiptychKeyDebugLog,
  isConfiguredKeyDebugEnabled,
  logDiptychRawKeyChunk,
} from '../core/key-debug.js';
import { killAllProcesses } from '../lib/process/registry.js';
import {
  installTerminalOutputErrorGuard,
  isBrokenOutputError,
  restoreTerminalControl,
} from '../lib/terminal/control.js';
import {
  resumeTerminalAfterEditor,
  setActiveTerminalHandover,
  suspendTerminalForEditor,
  type TerminalHandoverConfig,
} from '../lib/terminal/editor-handover.js';
import { flushOtel } from '../lib/otel.js';
import { awaitActiveWorkflowShutdown } from '../engine/orchestrator/session-lifecycle.js';
import { toErrorMessage } from '../utils/format-errors.js';
import { teardownStores } from './init-stores.js';

interface RenderOptions {
  fullscreen: boolean;
  mouse?: boolean;
  hover?: boolean;
  projectDir?: string | undefined;
}

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

interface RenderInputConfig {
  useFilteredStdin: boolean;
  useMouse: boolean;
  useHover: boolean;
  usePaste: boolean;
}

export function resolveRenderInputConfig(options: {
  fullscreen: boolean;
  mouse?: boolean | undefined;
  hover?: boolean | undefined;
}): RenderInputConfig {
  const usePaste = options.fullscreen;
  const useMouse = options.mouse !== false && options.fullscreen;
  return {
    useFilteredStdin: usePaste,
    useMouse,
    useHover: (options.hover ?? false) && useMouse,
    usePaste,
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

export async function startFullscreenThenActivateHandover(deps: {
  start: () => Promise<void>;
  publishFilteredStdin?: (() => void) | undefined;
  activateFilteredStdin?: (() => void) | undefined;
  handover: TerminalHandoverConfig;
  setHandover: (config: TerminalHandoverConfig | undefined) => void;
}): Promise<void> {
  deps.publishFilteredStdin?.();
  await deps.start();
  deps.activateFilteredStdin?.();
  deps.setHandover(deps.handover);
}

export function prepareInlineFallbackAfterFullscreenFailure(deps: {
  sourceStdin: NodeJS.ReadStream;
  clearTerminalHandover: () => void;
  clearFilteredStdin: () => void;
  disableFilteredStdin: () => void;
}): NodeJS.ReadStream {
  deps.clearTerminalHandover();
  deps.clearFilteredStdin();
  deps.disableFilteredStdin();
  return deps.sourceStdin;
}

export async function renderApp(
  appElement: ReturnType<typeof createElement>,
  options: RenderOptions,
): Promise<void> {
  const { fullscreen, mouse, hover, projectDir } = options;
  const kittyKeyboard = detectKittyKeyboardFlags();
  installTerminalOutputErrorGuard();

  configureDiptychKeyDebugLog(projectDir ? { projectDir } : undefined);

  const { useFilteredStdin, useMouse, useHover, usePaste } = resolveRenderInputConfig({
    fullscreen,
    mouse,
    hover,
  });
  let filteredStdin: FilteredStdin | undefined;
  let filteredDisabled = false;

  const rawKeyTap = isConfiguredKeyDebugEnabled()
    ? (chunk: Buffer) => logDiptychRawKeyChunk(chunk)
    : undefined;
  if (rawKeyTap) {
    process.stdin.on('data', rawKeyTap);
  }

  if (useFilteredStdin) {
    filteredStdin = createFilteredStdin(process.stdin, {
      activate: false,
      mouse: useMouse,
      hover: useHover,
    });
  }

  const disableFilteredStdin = () => {
    if (filteredDisabled) return;
    filteredDisabled = true;
    filteredStdin?.disable();
  };

  const cleanupTerminal = () => {
    setActiveTerminalHandover(undefined);
    setActiveFilteredStdin(undefined);
    disableFilteredStdin();
    if (rawKeyTap) process.stdin.off('data', rawKeyTap);
    restoreTerminal({ fullscreen, stdin: process.stdin });
  };

  const reapAndRestore = () => {
    try {
      try {
        teardownStores();
      } finally {
        killAllProcesses();
      }
    } finally {
      cleanupTerminal();
    }
  };

  // A fullscreen `kill` reaches this handler at the same time as the in-flight workflow's
  // own signal-driven shutdown; exiting the process here would race it to completion and
  // skip the mid-task rollback. Await that shutdown first so the TUI discards a partially
  // applied task exactly like the headless host does.
  const onTerminationSignal = createTerminationHandler({
    cleanup: reapAndRestore,
    exit: (code) => {
      void awaitActiveWorkflowShutdown()
        .then(flushOtel)
        .finally(() => process.exit(code));
    },
  });
  process.on('SIGINT', onTerminationSignal);
  process.on('SIGTERM', onTerminationSignal);
  process.on('SIGHUP', onTerminationSignal);

  const onCrash = createCrashHandler({
    cleanup: reapAndRestore,
    report: (reason) => {
      process.stderr.write(`diptych crashed: ${toErrorMessage(reason)}\n`);
    },
    exit: (code) => {
      void flushOtel().finally(() => process.exit(code));
    },
  });
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);

  // SIGTSTP must remove its own listener before re-raising so the kernel applies Node's default
  // stop disposition; SIGCONT re-installs it after restoring so a second Ctrl+Z still works. The
  // toggle keeps install/uninstall balanced so a spurious SIGCONT cannot stack a second listener.
  const suspendListener = createSuspendListenerToggle({
    install: () => process.on('SIGTSTP', onSuspend),
    uninstall: () => process.off('SIGTSTP', onSuspend),
  });
  const onSuspend = createSuspendHandler({
    save: () => suspendTerminalForEditor(),
    raiseDefault: () => {
      suspendListener.uninstall();
      process.kill(process.pid, 'SIGTSTP');
    },
  });
  const onResume = createResumeHandler({
    restore: () => {
      resumeTerminalAfterEditor();
      suspendListener.install();
    },
  });
  suspendListener.install();
  process.on('SIGCONT', onResume);

  const renderFallback = (stdin?: NodeJS.ReadStream) => {
    return render(appElement, {
      exitOnCtrlC: false,
      incrementalRendering: true,
      maxFps: 30,
      kittyKeyboard,
      ...(stdin ? { stdin } : {}),
    });
  };

  try {
    if (fullscreen) {
      const inkStdin = filteredStdin?.stdin;
      let ink: ReturnType<typeof withFullScreen> | undefined;
      try {
        const fullscreenInk = withFullScreen(appElement, {
          exitOnCtrlC: false,
          kittyKeyboard,
          ...(inkStdin ? { stdin: inkStdin } : {}),
        });
        ink = fullscreenInk;
        await startFullscreenThenActivateHandover({
          start: () => fullscreenInk.start(),
          publishFilteredStdin: filteredStdin
            ? () => {
                setActiveFilteredStdin(filteredStdin);
              }
            : undefined,
          activateFilteredStdin: filteredStdin
            ? () => {
                filteredStdin.activate();
              }
            : undefined,
          handover: {
            fullscreen: true,
            mouse: useMouse,
            paste: usePaste,
            hover: useHover,
            sourceStdin: process.stdin,
          },
          setHandover: setActiveTerminalHandover,
        });
      } catch (err) {
        if (isBrokenOutputError(err)) return;
        warnError('Fullscreen init failed, falling back to inline mode', err);
        const fallbackStdin = prepareInlineFallbackAfterFullscreenFailure({
          sourceStdin: process.stdin,
          clearTerminalHandover: () => setActiveTerminalHandover(undefined),
          clearFilteredStdin: () => setActiveFilteredStdin(undefined),
          disableFilteredStdin,
        });
        const inst = renderFallback(fallbackStdin);
        try {
          await inst.waitUntilExit();
        } catch (fallbackErr) {
          if (!isBrokenOutputError(fallbackErr)) throw fallbackErr;
        }
        return;
      }
      if (!ink) return;
      try {
        await ink.waitUntilExit();
      } catch (err) {
        if (!isBrokenOutputError(err)) throw err;
      }
    } else {
      const inst = renderFallback();
      await inst.waitUntilExit();
    }
  } finally {
    process.off('SIGINT', onTerminationSignal);
    process.off('SIGTERM', onTerminationSignal);
    process.off('SIGHUP', onTerminationSignal);
    process.off('SIGTSTP', onSuspend);
    process.off('SIGCONT', onResume);
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
    teardownStores();
    cleanupTerminal();
    await flushOtel();
  }
}
