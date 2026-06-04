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
import { isKeyDebugEnabled, logRawChunk } from '../lib/terminal/debug-keys.js';
import { killAllProcesses } from '../lib/process/registry.js';

interface RenderOptions {
  fullscreen: boolean;
  mouse?: boolean;
}

const SIGNAL_EXIT_CODE: Record<TerminationSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

type TerminationSignal = 'SIGINT' | 'SIGTERM';

const EXIT_ALT_BUFFER = '\u001b[?1049l';
const SHOW_CURSOR = '\u001b[?25h';

// fullscreen-ink restores the main screen buffer only after `waitUntilExit()` resolves, but a
// signal handler that calls `process.exit()` terminates before that async cleanup can run. So
// on a signal during fullscreen we must exit the alternate buffer and unhide the cursor here,
// otherwise the terminal is left on the alternate screen and needs a manual `reset`.
export function restoreTerminal(fullscreen: boolean): void {
  if (!fullscreen) return;
  process.stdout.write(EXIT_ALT_BUFFER);
  process.stdout.write(SHOW_CURSOR);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
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
    deps.cleanup();
    deps.exit(SIGNAL_EXIT_CODE[signal]);
  };
}

export async function renderApp(
  appElement: ReturnType<typeof createElement>,
  options: RenderOptions,
): Promise<void> {
  const { fullscreen, mouse } = options;
  const kittyKeyboard = detectKittyKeyboardFlags();

  const useMouse = mouse !== false && fullscreen;
  let filteredStdin: FilteredStdin | undefined;

  const rawKeyTap = isKeyDebugEnabled() ? (chunk: Buffer) => logRawChunk(chunk) : undefined;
  if (rawKeyTap) {
    process.stdin.on('data', rawKeyTap);
  }

  if (useMouse) {
    filteredStdin = createFilteredStdin(process.stdin);
    setActiveFilteredStdin(filteredStdin);
  }

  const onTerminationSignal = createTerminationHandler({
    cleanup: () => {
      killAllProcesses();
      setActiveFilteredStdin(undefined);
      filteredStdin?.disable();
      if (rawKeyTap) process.stdin.off('data', rawKeyTap);
      restoreTerminal(fullscreen);
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
      try {
        const inkStdin = filteredStdin?.stdin;
        const ink = withFullScreen(appElement, {
          exitOnCtrlC: false,
          kittyKeyboard,
          ...(inkStdin ? { stdin: inkStdin } : {}),
        });
        await ink.start();
        await ink.waitUntilExit();
      } catch (err) {
        warnError('Fullscreen init failed, falling back to inline mode', err);
        const inst = renderFallback();
        await inst.waitUntilExit();
      }
    } else {
      const inst = renderFallback();
      await inst.waitUntilExit();
    }
  } finally {
    process.off('SIGINT', onTerminationSignal);
    process.off('SIGTERM', onTerminationSignal);
    setActiveFilteredStdin(undefined);
    filteredStdin?.disable();
    if (rawKeyTap) {
      process.stdin.off('data', rawKeyTap);
    }
  }
}
