import { render } from 'ink';
import { withFullScreen } from 'fullscreen-ink';
import type { createElement } from 'react';
import { warnError } from '../../lib/warn.js';
import { createFilteredStdin } from '../../lib/terminal/filtered-stdin/create.js';
import type { FilteredStdin } from '../../lib/terminal/filtered-stdin/types.js';
import { setActiveFilteredStdin } from '../../lib/terminal/filtered-stdin/active.js';
import { detectKittyKeyboardFlags } from '../../lib/terminal/kitty-keyboard.js';
import {
  configureDiptychKeyDebugLog,
  isConfiguredKeyDebugEnabled,
  logDiptychRawKeyChunk,
} from '../../core/key-debug.js';
import { killAllProcesses } from '../../lib/process/registry.js';
import {
  installTerminalOutputErrorGuard,
  isBrokenOutputError,
} from '../../lib/terminal/control.js';
import {
  resumeTerminalAfterEditor,
  setActiveTerminalHandover,
  suspendTerminalForEditor,
} from '../../lib/terminal/editor-handover.js';
import { flushOtel } from '../../lib/otel.js';
import { awaitActiveWorkflowShutdown } from '../../engine/orchestrator/session-lifecycle/shutdown.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { teardownStores } from '../init-stores.js';
import { resolveRenderInputConfig } from './input-config.js';
import {
  createCrashHandler,
  createResumeHandler,
  createSuspendHandler,
  createSuspendListenerToggle,
  createTerminationHandler,
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
