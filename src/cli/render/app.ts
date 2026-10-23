import { type Instance, render } from 'ink';
import { withFullScreen } from 'fullscreen-ink';
import type { createElement } from 'react';
import { installDiagnosticSink, warnError, warnStderr } from '../../lib/warn.js';
import { createLogger } from '../../lib/logger.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { copyToClipboard } from '../../lib/clipboard/clipboard.js';
import { installTerminalSelection } from '../../lib/terminal/selection.js';
import { createFilteredStdin } from '../../lib/terminal/filtered-stdin/create.js';
import type { FilteredStdin } from '../../lib/terminal/filtered-stdin/types.js';
import { setActiveFilteredStdin } from '../../lib/terminal/filtered-stdin/active.js';
import { detectKittyKeyboardFlags } from '../../lib/terminal/kitty-keyboard.js';
import { queryTerminalBackground } from '../../lib/terminal/background.js';
import { terminalBackgroundStore } from '../../stores/ui/terminal-background.js';
import {
  configureSplitbriefKeyDebugLog,
  isConfiguredKeyDebugEnabled,
  logSplitbriefRawKeyChunk,
} from '../../core/key-debug.js';
import {
  installTerminalOutputErrorGuard,
  isBrokenOutputError,
} from '../../lib/terminal/control.js';
import type { TerminationSignal } from '../../engine/orchestrator/signals.js';
import {
  resumeTerminalAfterEditor,
  setActiveTerminalHandover,
  suspendTerminalForEditor,
} from '../../lib/terminal/editor-handover.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { resolveRenderInputConfig } from './input-config.js';
import { createEditorOutput } from './editor-output.js';
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
  /**
   * Aborting unmounts the TUI and resolves the render promise once the terminal
   * is restored, so a caller that mounted Ink ahead of its own work can write to
   * a plain terminal instead of into the alternate screen buffer.
   */
  unmountSignal?: AbortSignal | undefined;
}

const diagnosticLog = createLogger('diagnostics');
const BACKGROUND_QUERY_TIMEOUT_MS = 300;

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

function unmountWhenSignalled(
  instance: Instance,
  signal: AbortSignal | undefined,
  beforeUnmount?: () => void,
): void {
  if (!signal) return;
  const unmount = () => {
    beforeUnmount?.();
    instance.unmount();
  };
  if (signal.aborted) {
    unmount();
    return;
  }
  signal.addEventListener('abort', unmount, { once: true });
}

export async function renderApp(
  appElement: ReturnType<typeof createElement>,
  options: RenderOptions,
  deps: { exit: (code: number) => void } = { exit: (code) => process.exit(code) },
): Promise<void> {
  const { fullscreen, mouse, hover, projectDir, unmountSignal } = options;
  let processCompletion: Promise<void> | undefined;
  const kittyKeyboard = detectKittyKeyboardFlags();
  installTerminalOutputErrorGuard();

  configureSplitbriefKeyDebugLog(projectDir ? { projectDir } : undefined);

  const { useMouse, useHover, usePaste } = resolveRenderInputConfig({
    fullscreen,
    mouse,
    hover,
  });
  if (fullscreen && process.stdin.isTTY && process.stdout.isTTY) {
    const background = await queryTerminalBackground(
      process.stdin,
      process.stdout,
      BACKGROUND_QUERY_TIMEOUT_MS,
    );
    if (background !== undefined) terminalBackgroundStore.detected(background);
  }
  let filteredStdin: FilteredStdin;
  const selection =
    fullscreen && useMouse && process.stdout.isTTY
      ? installTerminalSelection({
          stdout: process.stdout,
          copy: copyToClipboard,
          reportError: (message) => feedbackStore.setError(message),
          onCopyKey: (result) => {
            filteredStdin.stdin.emit('selection-copy', result);
          },
        })
      : undefined;

  const rawKeyTap = isConfiguredKeyDebugEnabled()
    ? (chunk: Buffer) => logSplitbriefRawKeyChunk(chunk)
    : undefined;
  if (rawKeyTap) {
    process.stdin.on('data', rawKeyTap);
  }

  // Ink reads its keys through this stream in both render modes: it writes each backspace byte
  // as its own key, which Ink would otherwise join with the rest of the read.
  filteredStdin = createFilteredStdin(process.stdin, {
    activate: false,
    mouse: useMouse,
    hover: useHover,
    paste: usePaste,
    handleMouse: selection?.handleMouse,
    filterInput: selection?.filterInput,
    onPaste: selection?.clear,
  });

  const disableFilteredStdin = () => {
    selection?.dispose();
    filteredStdin.disable();
  };

  // While the TUI owns the terminal a recoverable diagnostic goes to the debug log and the
  // feedback line unless marked log-only, never as raw stderr into the frame. A feedback
  // diagnostic raised during teardown or rejected is written after the terminal is restored.
  const deferredDiagnostics: string[] = [];
  let tearingDown = false;
  const releaseDiagnosticSink = installDiagnosticSink((message, presentation) => {
    diagnosticLog.warn(message);
    if (presentation === 'log-only') return;
    if (tearingDown || presentation === 'at-exit') {
      deferredDiagnostics.push(message);
      return;
    }
    try {
      feedbackStore.setError(message);
    } catch {
      deferredDiagnostics.push(message);
    }
  });

  // Every frame Ink writes goes through this stream. Ink unmounts on process exit and paints
  // a final frame, which after a signal or a crash would land on the restored main screen
  // (a frame as tall as the terminal clears it and the scrollback), so the restore closes it
  // first; only the keyboard-mode pop of that unmount still reaches the terminal.
  const editorOutput = createEditorOutput(process.stdout);
  const cleanupTerminal = () => {
    try {
      editorOutput.close();
      setActiveTerminalHandover(undefined);
      setActiveFilteredStdin(undefined);
      disableFilteredStdin();
      if (rawKeyTap) process.stdin.off('data', rawKeyTap);
      restoreTerminal({ fullscreen, stdin: process.stdin });
    } finally {
      releaseDiagnosticSink();
      for (const message of deferredDiagnostics.splice(0)) warnStderr(message);
    }
  };

  const cleanupTui = createTuiCleanup({ restore: cleanupTerminal });
  const cleanup = () => {
    tearingDown = true;
    selection?.suspend();
    return cleanupTui();
  };

  // A fullscreen `kill` reaches this handler at the same time as the in-flight workflow's
  // own signal-driven shutdown; exiting the process here would race it to completion and
  // skip the mid-task rollback. Await cleanup before exiting so the TUI discards a partially
  // applied task exactly like the headless host does.
  const reportTerminationCleanupFailure = (error: unknown) =>
    warnError(
      'Could not stop every tool process while SPLITBRIEF stopped, so one may keep running',
      error,
    );
  const onTerminationSignal = createTerminationHandler({
    cleanup,
    reportCleanupFailure: reportTerminationCleanupFailure,
    exit: deps.exit,
  });
  const settleTerminationSignal = createTerminationSignalListener({
    handle: (signal) => {
      processCompletion ??= onTerminationSignal(signal);
      return processCompletion;
    },
    reportCleanupFailure: reportTerminationCleanupFailure,
  });
  process.on('SIGINT', settleTerminationSignal);
  process.on('SIGTERM', settleTerminationSignal);
  process.on('SIGHUP', settleTerminationSignal);

  const reportCrash = (reason: unknown) => {
    process.stderr.write(`SPLITBRIEF crashed: ${toErrorMessage(reason)}\n`);
  };
  const reportCrashCleanupFailure = (error: unknown) =>
    warnError('Could not stop every tool process after the crash, so one may keep running', error);
  const onCrash = createCrashHandler({
    cleanup,
    report: reportCrash,
    reportCleanupFailure: reportCrashCleanupFailure,
    exit: deps.exit,
  });
  const settleCrash = createCrashListener({
    handle: (reason) => {
      processCompletion ??= onCrash(reason);
      return processCompletion;
    },
    reportCrash,
    reportCleanupFailure: reportCrashCleanupFailure,
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

  // No `incrementalRendering`: Ink 6.8's incremental writer assumes the cursor rests on the
  // last rendered line, but Ink writes a frame shorter than the terminal with a trailing
  // newline and the cursor a row below it (log-update.js:164 against ink.js:320-321), so every
  // repaint of a short frame lands one row low. Ink 7.0.0 fixed that arithmetic, but the
  // manifest pins `^6.8.0`, so restoring this needs a major bump the repo has not taken. The
  // cost is a whole-frame rewrite per repaint, which Ink brackets in DEC 2026 synchronized
  // output on a TTY outside CI (ink/build/write-synchronized.js) and leaves unbracketed on a
  // pipe. Under CI there is no cost at all: Ink drops every non-static redraw (ink.js:262).
  const renderFallback = (input: FilteredStdin) => {
    setActiveTerminalHandover({
      fullscreen: false,
      mouse: false,
      sourceStdin: process.stdin,
      beforeSuspend: editorOutput.suspend,
      beforeResume: editorOutput.resume,
      keyboardPush: editorOutput.keyboardPush,
    });
    const instance = render(appElement, {
      exitOnCtrlC: false,
      maxFps: 30,
      kittyKeyboard,
      stdout: editorOutput.stdout,
      stdin: input.stdin,
    });
    input.activate();
    return instance;
  };

  try {
    if (fullscreen) {
      const fullscreenStdin = filteredStdin;
      let ink: ReturnType<typeof withFullScreen> | undefined;
      try {
        const fullscreenInk = withFullScreen(appElement, {
          exitOnCtrlC: false,
          kittyKeyboard,
          stdout: editorOutput.stdout,
          stdin: fullscreenStdin.stdin,
        });
        ink = fullscreenInk;
        await startFullscreenThenActivateHandover({
          start: () => fullscreenInk.start(),
          publishFilteredStdin: () => {
            setActiveFilteredStdin(fullscreenStdin);
          },
          activateFilteredStdin: () => {
            fullscreenStdin.activate();
          },
          handover: {
            fullscreen: true,
            mouse: useMouse,
            paste: usePaste,
            hover: useHover,
            sourceStdin: process.stdin,
            beforeSuspend: () => {
              editorOutput.suspend();
              selection?.suspend();
            },
            beforeResume: () => {
              editorOutput.resume();
              selection?.resume();
            },
            keyboardPush: editorOutput.keyboardPush,
          },
          setHandover: setActiveTerminalHandover,
        });
      } catch (err) {
        ink = undefined;
        if (!isBrokenOutputError(err)) {
          warnError('Fullscreen init failed, falling back to inline mode', err);
          filteredStdin = prepareInlineFallbackAfterFullscreenFailure({
            clearTerminalHandover: () => setActiveTerminalHandover(undefined),
            clearFilteredStdin: () => setActiveFilteredStdin(undefined),
            disableFilteredStdin,
            createInlineStdin: () =>
              createFilteredStdin(process.stdin, { activate: false, mouse: false, paste: false }),
          });
          const inst = renderFallback(filteredStdin);
          unmountWhenSignalled(inst, unmountSignal);
          try {
            await inst.waitUntilExit();
          } catch (fallbackErr) {
            if (!isBrokenOutputError(fallbackErr)) throw fallbackErr;
          }
        }
      }
      if (ink !== undefined) {
        unmountWhenSignalled(ink.instance, unmountSignal, selection?.suspend);
        try {
          await ink.waitUntilExit();
        } catch (err) {
          if (!isBrokenOutputError(err)) throw err;
        }
      }
    } else {
      const inst = renderFallback(filteredStdin);
      unmountWhenSignalled(inst, unmountSignal);
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
  if (processCompletion !== undefined) await processCompletion;
  else if (!unmountSignal?.aborted) deps.exit(Number(process.exitCode ?? 0));
}
