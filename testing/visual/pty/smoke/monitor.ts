import { terminalSequences } from '../../../../src/lib/terminal/control.js';
import type { Viewport } from '../../contracts/geometry.js';
import { PTY_CHILD_EXIT_INPUT, PTY_CHILD_MARKER } from '../child.js';
import type { PtyExitEvent, PtyProcess } from './capability.js';
import type { PtySmokeResult, RunPtySmokeOptions } from './run.js';

const TERMINATION_GRACE_MS = 250;
const FORCE_SETTLE_MS = 750;
const MAX_RAW_IO_CODE_UNITS = 1_048_576;

export function monitorChild(input: {
  readonly child: PtyProcess;
  readonly options: RunPtySmokeOptions;
}): Promise<Extract<PtySmokeResult, { readonly status: 'passed' }>> {
  const { child, options } = input;
  return new Promise((resolvePromise, rejectPromise) => {
    let rawIo = '';
    let markerSeen = false;
    let exitInputSent = false;
    let settled = false;
    let termination: 'timeout' | 'output-limit' | 'signal' | null = null;
    let terminationTimer: NodeJS.Timeout | undefined;
    let forceSettleTimer: NodeJS.Timeout | undefined;

    const finish = (event: PtyExitEvent): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      dataDisposable.dispose();
      exitDisposable.dispose();
      removeSignalListeners();

      if (termination !== null) {
        rejectPromise(terminationError(termination));
        return;
      }
      if (!markerSeen || !exitInputSent) {
        rejectPromise(ptyError('pty-smoke-marker-missing', 'PTY child exited before its marker'));
        return;
      }
      if (event.exitCode !== 0) {
        rejectPromise(
          ptyError('pty-smoke-child-exit', `PTY child exited with code ${event.exitCode}`),
        );
        return;
      }
      if (!hasRestoredTerminal(rawIo)) {
        rejectPromise(
          ptyError('pty-smoke-restoration', 'PTY child did not restore fullscreen terminal state'),
        );
        return;
      }
      resolvePromise({
        status: 'passed',
        viewport: options.viewport,
        marker: PTY_CHILD_MARKER,
        rawIo,
        pid: child.pid,
        exitCode: event.exitCode,
        resizeVerified: true,
        terminalRestored: true,
        processGroupReaped: true,
      });
    };

    const forceFinish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      dataDisposable.dispose();
      exitDisposable.dispose();
      removeSignalListeners();
      rejectPromise(
        ptyError('pty-smoke-cleanup', 'PTY child did not exit after process-group cleanup'),
      );
    };

    const terminate = (reason: Exclude<typeof termination, null>): void => {
      if (termination !== null || settled) return;
      termination = reason;
      signalProcessGroup(child, 'SIGTERM');
      if (settled) return;
      terminationTimer = setTimeout(
        () => signalProcessGroup(child, 'SIGKILL'),
        TERMINATION_GRACE_MS,
      );
      forceSettleTimer = setTimeout(forceFinish, FORCE_SETTLE_MS);
    };

    const onSignal = (): void => terminate('signal');
    const removeSignalListeners = (): void => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };

    const dataDisposable = child.onData((data) => {
      if (settled) return;
      rawIo += data;
      if (rawIo.length > MAX_RAW_IO_CODE_UNITS) {
        terminate('output-limit');
        return;
      }
      if (!markerSeen && rawIo.includes(PTY_CHILD_MARKER)) {
        markerSeen = true;
        exitInputSent = true;
        child.write(PTY_CHILD_EXIT_INPUT);
      }
    });
    const exitDisposable = child.onExit(finish);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    const timeoutTimer = setTimeout(() => terminate('timeout'), options.timeoutMs);

    try {
      verifyResizeRoundTrip(child, options.viewport);
    } catch (error) {
      terminate('signal');
      if (!settled) {
        settled = true;
        clearTimeout(timeoutTimer);
        if (terminationTimer) clearTimeout(terminationTimer);
        if (forceSettleTimer) clearTimeout(forceSettleTimer);
        dataDisposable.dispose();
        exitDisposable.dispose();
        removeSignalListeners();
        rejectPromise(error);
      }
    }
  });
}

function verifyResizeRoundTrip(child: PtyProcess, viewport: Viewport): void {
  if (child.cols !== viewport.cols || child.rows !== viewport.rows) {
    throw ptyError('pty-smoke-viewport', 'PTY child did not start at the declared viewport');
  }
  child.resize(viewport.cols + 1, viewport.rows + 1);
  if (child.cols !== viewport.cols + 1 || child.rows !== viewport.rows + 1) {
    throw ptyError('pty-smoke-resize', 'PTY child did not report its resized viewport');
  }
  child.resize(viewport.cols, viewport.rows);
  if (child.cols !== viewport.cols || child.rows !== viewport.rows) {
    throw ptyError('pty-smoke-resize', 'PTY child did not restore its declared viewport');
  }
}

function signalProcessGroup(child: PtyProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (child.pid <= 1 || child.pid === process.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // node-pty implementations without a separate process group use their own kill boundary.
    }
  }
  try {
    child.kill(process.platform === 'win32' ? undefined : signal);
  } catch {
    // A concurrent clean exit means there is no remaining PTY process to kill.
  }
}

function hasRestoredTerminal(rawIo: string): boolean {
  const entered = rawIo.lastIndexOf(terminalSequences.enterAltBuffer);
  const hidden = rawIo.lastIndexOf(terminalSequences.hideCursor);
  const exited = rawIo.lastIndexOf(terminalSequences.exitAltBuffer);
  const shown = rawIo.lastIndexOf(terminalSequences.showCursor);
  return entered >= 0 && exited > entered && (hidden < 0 || shown > hidden);
}

function terminationError(reason: 'timeout' | 'output-limit' | 'signal'): Error {
  switch (reason) {
    case 'timeout':
      return ptyError('pty-smoke-timeout', 'PTY child timed out before clean exit');
    case 'output-limit':
      return ptyError('pty-smoke-output-limit', 'PTY child exceeded the raw I/O capture limit');
    case 'signal':
      return ptyError('pty-smoke-interrupted', 'PTY smoke was interrupted');
  }
}

function ptyError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
