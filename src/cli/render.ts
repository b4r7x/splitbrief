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

interface RenderOptions {
  fullscreen: boolean;
  mouse?: boolean;
  projectDir?: string | undefined;
}

const SIGNAL_EXIT_CODE: Record<TerminationSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

type TerminationSignal = 'SIGINT' | 'SIGTERM';

interface RestoreTerminalOptions {
  fullscreen: boolean;
  mouse?: boolean | undefined;
  stdin?: NodeJS.ReadStream | undefined;
}

// fullscreen-ink restores the main screen buffer only after `waitUntilExit()` resolves, but a
// signal handler that calls `process.exit()` terminates before that async cleanup can run. So
// on a signal during fullscreen we must exit the alternate buffer and unhide the cursor here,
// otherwise the terminal is left on the alternate screen and needs a manual `reset`.
export function restoreTerminal(options: RestoreTerminalOptions): void {
  restoreTerminalControl({
    fullscreen: options.fullscreen,
    mouse: options.mouse ?? false,
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

export async function renderApp(
  appElement: ReturnType<typeof createElement>,
  options: RenderOptions,
): Promise<void> {
  const { fullscreen, mouse, projectDir } = options;
  const kittyKeyboard = detectKittyKeyboardFlags();
  installTerminalOutputErrorGuard();

  configureDiptychKeyDebugLog(projectDir ? { projectDir } : undefined);

  const useMouse = mouse !== false && fullscreen;
  let filteredStdin: FilteredStdin | undefined;
  let filteredDisabled = false;

  const rawKeyTap = isConfiguredKeyDebugEnabled()
    ? (chunk: Buffer) => logDiptychRawKeyChunk(chunk)
    : undefined;
  if (rawKeyTap) {
    process.stdin.on('data', rawKeyTap);
  }

  if (useMouse) {
    filteredStdin = createFilteredStdin(process.stdin);
    setActiveFilteredStdin(filteredStdin);
  }

  const disableFilteredStdin = () => {
    if (filteredDisabled) return;
    filteredDisabled = true;
    filteredStdin?.disable();
  };

  const cleanupTerminal = () => {
    setActiveFilteredStdin(undefined);
    disableFilteredStdin();
    if (rawKeyTap) process.stdin.off('data', rawKeyTap);
    restoreTerminal({ fullscreen, stdin: process.stdin });
  };

  const onTerminationSignal = createTerminationHandler({
    cleanup: () => {
      try {
        killAllProcesses();
      } finally {
        cleanupTerminal();
      }
    },
    exit: (code) => process.exit(code),
  });
  process.on('SIGINT', onTerminationSignal);
  process.on('SIGTERM', onTerminationSignal);

  const renderFallback = () => {
    const inkStdin = filteredStdin?.stdin;
    return render(appElement, {
      exitOnCtrlC: false,
      incrementalRendering: true,
      maxFps: 30,
      kittyKeyboard,
      ...(inkStdin ? { stdin: inkStdin } : {}),
    });
  };

  try {
    if (fullscreen) {
      const inkStdin = filteredStdin?.stdin;
      let ink: ReturnType<typeof withFullScreen> | undefined;
      try {
        ink = withFullScreen(appElement, {
          exitOnCtrlC: false,
          kittyKeyboard,
          ...(inkStdin ? { stdin: inkStdin } : {}),
        });
        await ink.start();
      } catch (err) {
        if (isBrokenOutputError(err)) return;
        warnError('Fullscreen init failed, falling back to inline mode', err);
        const inst = renderFallback();
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
    cleanupTerminal();
  }
}
