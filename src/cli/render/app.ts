import type { createElement } from 'react';
import { warnError } from '../../lib/warn.js';
import { detectKittyKeyboardFlags } from '../../lib/terminal/kitty-keyboard.js';
import { queryTerminalBackground } from '../../lib/terminal/background.js';
import { terminalBackgroundStore } from '../../stores/ui/terminal-background.js';
import { configureSplitbriefKeyDebugLog } from '../../core/keybindings/debug-log.js';
import { installTerminalOutputErrorGuard } from '../../lib/terminal/control.js';
import {
  resumeTerminalAfterEditor,
  suspendTerminalForEditor,
} from '../../lib/terminal/editor-handover.js';
import type { TerminationSignal } from '../../lib/process/signals.js';
import { toErrorMessage } from '../../utils/format/errors.js';
import { holdSlowProbeLines } from '../slow-probe-line.js';
import { resolveRenderInputConfig } from './input-config.js';
import { createEditorOutput } from './editor-output.js';
import { mountTui } from './mount.js';
import {
  createCrashHandler,
  createCrashListener,
  createResumeHandler,
  createSuspendHandler,
  createTerminalCleanup,
  createTerminationHandler,
  createTerminationSignalListener,
} from './process-lifecycle.js';
import { openTuiInput } from './stdin.js';

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

const BACKGROUND_QUERY_TIMEOUT_MS = 300;

/**
 * The process listeners of the TUI. A termination signal and a crash share one completion: the
 * first one that arrives runs the cleanup and the exit, and a later one waits on it.
 */
interface ProcessListeners {
  completion: Promise<void> | undefined;
  settleTerminationSignal: (signal: TerminationSignal) => void;
  settleCrash: (reason: unknown) => void;
  onSuspend: () => void;
  onResume: () => void;
}

// A fullscreen `kill` reaches the termination handler at the same time as the in-flight
// workflow's own signal-driven shutdown; exiting the process there would race it to completion
// and skip the mid-task rollback. Await cleanup before exiting so the TUI discards a partially
// applied task exactly like the headless host does.
function installProcessListeners(
  cleanup: () => Promise<void>,
  exit: (code: number) => void,
): ProcessListeners {
  const reportTerminationCleanupFailure = (error: unknown) =>
    warnError(
      'Could not stop every tool process while SPLITBRIEF stopped, so one may keep running',
      error,
      'feedback',
    );
  const onTerminationSignal = createTerminationHandler({
    cleanup,
    reportCleanupFailure: reportTerminationCleanupFailure,
    exit,
  });
  const reportCrash = (reason: unknown) => {
    process.stderr.write(`SPLITBRIEF crashed: ${toErrorMessage(reason)}\n`);
  };
  const reportCrashCleanupFailure = (error: unknown) =>
    warnError(
      'Could not stop every tool process after the crash, so one may keep running',
      error,
      'feedback',
    );
  const onCrash = createCrashHandler({
    cleanup,
    report: reportCrash,
    reportCleanupFailure: reportCrashCleanupFailure,
    exit,
  });
  const listeners: ProcessListeners = {
    completion: undefined,
    settleTerminationSignal: createTerminationSignalListener({
      handle: (signal) => {
        listeners.completion ??= onTerminationSignal(signal);
        return listeners.completion;
      },
      reportCleanupFailure: reportTerminationCleanupFailure,
    }),
    settleCrash: createCrashListener({
      handle: (reason) => {
        listeners.completion ??= onCrash(reason);
        return listeners.completion;
      },
      reportCrash,
      reportCleanupFailure: reportCrashCleanupFailure,
    }),
    // The hand-off takes the SIGTSTP and SIGCONT listeners off, so the SIGTSTP raised again gets
    // Node's default stop. The SIGCONT of `fg` needs a listener to take the terminal back, and the
    // end of the hand-off puts both listeners back.
    onSuspend: createSuspendHandler({
      save: () => suspendTerminalForEditor(),
      raiseDefault: () => {
        process.once('SIGCONT', listeners.onResume);
        process.kill(process.pid, 'SIGTSTP');
      },
    }),
    onResume: createResumeHandler({ restore: () => resumeTerminalAfterEditor() }),
  };
  process.on('SIGINT', listeners.settleTerminationSignal);
  process.on('SIGTERM', listeners.settleTerminationSignal);
  process.on('SIGHUP', listeners.settleTerminationSignal);
  process.on('uncaughtException', listeners.settleCrash);
  process.on('unhandledRejection', listeners.settleCrash);
  process.on('SIGTSTP', listeners.onSuspend);
  process.on('SIGCONT', listeners.onResume);
  return listeners;
}

function removeProcessListeners(listeners: ProcessListeners): void {
  process.off('SIGINT', listeners.settleTerminationSignal);
  process.off('SIGTERM', listeners.settleTerminationSignal);
  process.off('SIGHUP', listeners.settleTerminationSignal);
  process.off('SIGTSTP', listeners.onSuspend);
  process.off('SIGCONT', listeners.onResume);
  process.off('uncaughtException', listeners.settleCrash);
  process.off('unhandledRejection', listeners.settleCrash);
}

export async function renderApp(
  appElement: ReturnType<typeof createElement>,
  options: RenderOptions,
  deps: { exit: (code: number) => void } = { exit: (code) => process.exit(code) },
): Promise<void> {
  const releaseSlowProbeLines = holdSlowProbeLines();
  const { fullscreen, mouse, hover, projectDir, unmountSignal } = options;
  const kittyKeyboard = detectKittyKeyboardFlags();
  installTerminalOutputErrorGuard();

  configureSplitbriefKeyDebugLog(projectDir ? { projectDir } : undefined);

  const modes = resolveRenderInputConfig({ fullscreen, mouse, hover });
  if (fullscreen && process.stdin.isTTY && process.stdout.isTTY) {
    const background = await queryTerminalBackground(
      process.stdin,
      process.stdout,
      BACKGROUND_QUERY_TIMEOUT_MS,
    );
    if (background !== undefined) terminalBackgroundStore.detected(background);
  }
  const input = openTuiInput(fullscreen, modes);
  const output = createEditorOutput(process.stdout);
  const cleanup = createTerminalCleanup(fullscreen, input, output);
  const listeners = installProcessListeners(cleanup, deps.exit);

  try {
    await mountTui(appElement, { fullscreen, kittyKeyboard, output, input, unmountSignal });
  } finally {
    removeProcessListeners(listeners);
    await cleanup();
    releaseSlowProbeLines();
  }
  if (listeners.completion !== undefined) await listeners.completion;
  else if (!unmountSignal?.aborted) deps.exit(Number(process.exitCode ?? 0));
}
