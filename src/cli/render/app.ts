import { render } from 'ink';
import { withFullScreen } from 'fullscreen-ink';
import type { createElement } from 'react';
import { warnError } from '../../lib/warn.js';
import { createFilteredStdin } from '../../lib/terminal/filtered-stdin/create.js';
import type { FilteredStdin } from '../../lib/terminal/filtered-stdin/types.js';
import { setActiveFilteredStdin } from '../../lib/terminal/filtered-stdin/active.js';
import { detectKittyKeyboardFlags } from '../../lib/terminal/kitty-keyboard.js';
import {
  configureSplitbriefKeyDebugLog,
  isConfiguredKeyDebugEnabled,
  logSplitbriefRawKeyChunk,
} from '../../core/key-debug.js';
import {
  installTerminalOutputErrorGuard,
  isBrokenOutputError,
} from '../../lib/terminal/control.js';
import {
  resumeTerminalAfterEditor,
  setActiveTerminalHandover,
  suspendTerminalForEditor,
} from '../../lib/terminal/editor-handover.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { resolveRenderInputConfig } from './input-config.js';
import {
  createCrashHandler,
  createResumeHandler,
  createSuspendHandler,
  createSuspendListenerToggle,
  createTerminationHandler,
  createTuiCleanup,
  restoreTerminal,
} from './process-lifecycle.js';
import {
  prepareInlineFallbackAfterFullscreenFailure,
  startFullscreenThenActivateHandover,
} from './terminal-handover.js';

interface RenderOptions {
  fullscreen: boolean;
  mouse?: boolean;
  hover?: boolean;
  projectDir?: string | undefined;
}

type TerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

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

export async function renderApp(
  appElement: ReturnType<typeof createElement>,
  options: RenderOptions,
): Promise<void> {
  const { fullscreen, mouse, hover, projectDir } = options;
  const kittyKeyboard = detectKittyKeyboardFlags();
  installTerminalOutputErrorGuard();

  configureSplitbriefKeyDebugLog(projectDir ? { projectDir } : undefined);

  const { useFilteredStdin, useMouse, useHover, usePaste } = resolveRenderInputConfig({
    fullscreen,
    mouse,
    hover,
  });
  let filteredStdin: FilteredStdin | undefined;
  let filteredDisabled = false;

  const rawKeyTap = isConfiguredKeyDebugEnabled()
    ? (chunk: Buffer) => logSplitbriefRawKeyChunk(chunk)
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

  const cleanup = createTuiCleanup({ restore: cleanupTerminal });

  // A fullscreen `kill` reaches this handler at the same time as the in-flight workflow's
  // own signal-driven shutdown; exiting the process here would race it to completion and
  // skip the mid-task rollback. Await cleanup before exiting so the TUI discards a partially
  // applied task exactly like the headless host does.
  const onTerminationSignal = createTerminationHandler({
    cleanup,
    exit: (code) => process.exit(code),
  });
  const settleTerminationSignal = createTerminationSignalListener({
    handle: onTerminationSignal,
    reportCleanupFailure: (error) => warnError('TUI cleanup failed during termination', error),
  });
  process.on('SIGINT', settleTerminationSignal);
  process.on('SIGTERM', settleTerminationSignal);
  process.on('SIGHUP', settleTerminationSignal);

  const reportCrash = (reason: unknown) => {
    process.stderr.write(`SPLITBRIEF crashed: ${toErrorMessage(reason)}\n`);
  };
  const onCrash = createCrashHandler({
    cleanup,
    report: reportCrash,
    exit: (code) => process.exit(code),
  });
  const settleCrash = createCrashListener({
    handle: onCrash,
    reportCrash,
    reportCleanupFailure: (error) => warnError('TUI cleanup failed during crash handling', error),
  });
  process.on('uncaughtException', settleCrash);
  process.on('unhandledRejection', settleCrash);

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
    process.off('SIGINT', settleTerminationSignal);
    process.off('SIGTERM', settleTerminationSignal);
    process.off('SIGHUP', settleTerminationSignal);
    process.off('SIGTSTP', onSuspend);
    process.off('SIGCONT', onResume);
    process.off('uncaughtException', settleCrash);
    process.off('unhandledRejection', settleCrash);
    await cleanup();
  }
}
