import { terminalSequences } from '../../../../src/lib/terminal/control.js';
import { stripTerminalControls } from '../../../../src/utils/display-text.js';
import { escapeRegExp } from '../../../../src/utils/regexp.js';
import {
  resolvePtyDisposable,
  type Disposable,
  type PtyExitEvent,
  type PtyProcess,
  type PtyProcessBoundary,
} from './capability.js';
import {
  PTY_ACTIVE_REVIEW_MARKER,
  PTY_APPROVAL_PREFIX,
  PTY_APPROVAL_SUFFIX,
  PTY_APPROVED_MARKER,
  PTY_EDIT_INPUT,
  PTY_EDITOR_FINISHED_MARKER,
  PTY_EDITOR_STARTED_MARKER,
  PTY_EXIT_INPUT,
  PTY_SUBMIT_INPUT,
} from './contract.js';

const TERMINATION_GRACE_MS = 250;
const REAP_DEADLINE_MS = 1_000;
const MAX_RAW_IO_CODE_UNITS = 1_048_576;

type ContractStep =
  | 'await-active'
  | 'await-draft'
  | 'await-editor-start'
  | 'await-editor-finish'
  | 'await-return'
  | 'await-complete-draft'
  | 'await-approval'
  | 'await-exit';

export interface PtyContractResult {
  readonly rawIo: string;
  readonly pid: number;
  readonly exitCode: 0;
  readonly editorReturned: true;
  readonly approved: true;
  readonly terminalRestored: true;
  readonly processGroupReaped: true;
}

export async function monitorPtyContract(input: {
  readonly child: PtyProcess;
  readonly timeoutMs: number;
}): Promise<PtyContractResult> {
  const { child, timeoutMs } = input;
  let rawIo = '';
  const contract: { step: ContractStep } = { step: 'await-active' };
  let draftOffset = 0;
  let completedDraftOffset = 0;
  let returnOffset = 0;
  let editorPid: number | undefined;
  let failure: Error | undefined;
  let processExited = false;
  let dataDisposable: Disposable | undefined;
  let exitDisposable: Disposable | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let signalListenersInstalled = false;
  let exitRegistrationAttempted = false;
  let exitObservationAvailable = false;
  const { promise: failurePromise, resolve: resolveFailure } = Promise.withResolvers<Error>();
  const { promise: exitPromise, resolve: resolveExit } = Promise.withResolvers<PtyExitEvent>();

  const fail = (error: Error): void => {
    if (failure) return;
    failure = error;
    resolveFailure(error);
  };

  const write = (data: string): void => {
    try {
      child.write(data);
    } catch {
      fail(ptyError('pty-contract-write', 'PTY child input failed'));
    }
  };

  const advance = (): void => {
    let progressed = true;
    while (progressed && !failure) {
      progressed = false;
      switch (contract.step) {
        case 'await-active':
          if (rawIo.includes(PTY_ACTIVE_REVIEW_MARKER)) {
            contract.step = 'await-draft';
            draftOffset = rawIo.length;
            write(PTY_APPROVAL_PREFIX);
            progressed = true;
          }
          break;
        case 'await-draft':
          if (hasComposerDraft(rawIo.slice(draftOffset))) {
            contract.step = 'await-editor-start';
            write(PTY_EDIT_INPUT);
            progressed = true;
          }
          break;
        case 'await-editor-start':
          if (rawIo.includes(PTY_EDITOR_STARTED_MARKER)) {
            editorPid = readEditorPid(rawIo);
            if (editorPid === undefined) {
              fail(ptyError('pty-contract-editor-pid', 'PTY editor did not report a valid PID'));
              break;
            }
            contract.step = 'await-editor-finish';
            progressed = true;
          }
          break;
        case 'await-editor-finish': {
          const markerOffset = rawIo.indexOf(PTY_EDITOR_FINISHED_MARKER);
          if (markerOffset >= 0) {
            returnOffset = markerOffset + PTY_EDITOR_FINISHED_MARKER.length;
            contract.step = 'await-return';
            progressed = true;
          }
          break;
        }
        case 'await-return': {
          const afterEditor = rawIo.slice(returnOffset);
          if (afterEditor.includes(PTY_ACTIVE_REVIEW_MARKER) && hasComposerDraft(afterEditor)) {
            contract.step = 'await-complete-draft';
            completedDraftOffset = rawIo.length;
            write(PTY_APPROVAL_SUFFIX);
            progressed = true;
          }
          break;
        }
        case 'await-complete-draft':
          if (hasCompletedComposerDraft(rawIo.slice(completedDraftOffset))) {
            contract.step = 'await-approval';
            write(PTY_SUBMIT_INPUT);
            progressed = true;
          }
          break;
        case 'await-approval':
          if (rawIo.includes(PTY_APPROVED_MARKER)) {
            contract.step = 'await-exit';
            write(PTY_EXIT_INPUT);
            progressed = true;
          }
          break;
        case 'await-exit':
          break;
      }
    }
  };

  const onSignal = (): void => {
    fail(ptyError('pty-contract-interrupted', 'PTY contract was interrupted'));
  };

  const registerExitListener = (): void => {
    exitRegistrationAttempted = true;
    let registration: unknown;
    try {
      registration = child.onExit((event) => {
        processExited = true;
        resolveExit(event);
      });
      exitObservationAvailable = true;
    } catch (error) {
      throw ptyError('pty-contract-listener', 'PTY child exit listener registration failed', error);
    }
    exitDisposable = resolvePtyDisposable(registration) ?? undefined;
    if (!exitDisposable) {
      throw ptyError(
        'pty-contract-listener',
        'PTY child exit listener returned an invalid disposable',
      );
    }
  };

  try {
    let dataRegistration: unknown;
    try {
      dataRegistration = child.onData((data) => {
        if (failure) return;
        rawIo += data;
        if (rawIo.length > MAX_RAW_IO_CODE_UNITS) {
          fail(ptyError('pty-contract-output-limit', 'PTY child exceeded the output limit'));
          return;
        }
        advance();
      });
    } catch (error) {
      throw ptyError('pty-contract-listener', 'PTY child data listener registration failed', error);
    }
    dataDisposable = resolvePtyDisposable(dataRegistration) ?? undefined;
    if (!dataDisposable) {
      throw ptyError(
        'pty-contract-listener',
        'PTY child data listener returned an invalid disposable',
      );
    }
    registerExitListener();

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    signalListenersInstalled = true;
    timeout = setTimeout(
      () => fail(ptyError('pty-contract-timeout', `PTY contract timed out at ${contract.step}`)),
      timeoutMs,
    );

    const outcome = await Promise.race([
      exitPromise.then((event) => ({ kind: 'exit' as const, event })),
      failurePromise.then((error) => ({ kind: 'failure' as const, error })),
    ]);

    if (outcome.kind === 'failure') {
      throw outcome.error;
    }
    if (contract.step !== 'await-exit') {
      throw ptyError('pty-contract-incomplete', 'PTY child exited before completing the contract');
    }
    if (outcome.event.exitCode !== 0) {
      throw ptyError(
        'pty-contract-child-exit',
        `PTY child exited with code ${outcome.event.exitCode}`,
      );
    }
    if (!hasRestoredTerminal(rawIo)) {
      throw ptyError('pty-contract-restoration', 'PTY child did not restore terminal state');
    }
    if (editorPid === undefined || isPidAlive(editorPid)) {
      throw ptyError('pty-contract-editor-reap', 'PTY editor process was not reaped');
    }
    return {
      rawIo,
      pid: child.pid,
      exitCode: 0,
      editorReturned: true,
      approved: true,
      terminalRestored: true,
      processGroupReaped: true,
    };
  } catch (primaryError) {
    if (!processExited) {
      let effectiveError = primaryError;
      if (!exitRegistrationAttempted) {
        try {
          registerExitListener();
        } catch (error) {
          effectiveError = ptyError(
            'pty-contract-listener',
            'PTY child exit listener registration failed during cleanup',
            new AggregateError(
              [primaryError, error],
              'PTY listener setup and cleanup registration both failed',
            ),
          );
        }
      }
      await terminatePtyProcessGroup(
        child,
        exitObservationAvailable ? exitPromise : undefined,
        effectiveError,
      );
      throw effectiveError;
    }
    throw primaryError;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signalListenersInstalled) {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
    try {
      dataDisposable?.dispose();
    } finally {
      exitDisposable?.dispose();
    }
  }
}

export async function terminatePtyProcessGroup(
  child: PtyProcessBoundary,
  exitPromise: Promise<PtyExitEvent> | undefined,
  cause?: unknown,
): Promise<void> {
  signalProcessGroup(child, 'SIGTERM');
  if (!exitPromise) {
    signalProcessGroup(child, 'SIGKILL');
    throw ptyError(
      'pty-contract-cleanup',
      'PTY process group was terminated without a reap observation',
      cause,
    );
  }
  if (await settlesBefore(exitPromise, TERMINATION_GRACE_MS)) return;
  signalProcessGroup(child, 'SIGKILL');
  if (await settlesBefore(exitPromise, REAP_DEADLINE_MS)) return;
  throw ptyError('pty-contract-cleanup', 'PTY process group could not be reaped', cause);
}

async function settlesBefore(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signalProcessGroup(child: PtyProcessBoundary, signal: 'SIGTERM' | 'SIGKILL'): void {
  const hasSafeGroupPid =
    Number.isSafeInteger(child.pid) && child.pid > 1 && child.pid !== process.pid;
  if (process.platform !== 'win32' && hasSafeGroupPid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The PTY may expose only its direct child boundary.
    }
  }
  try {
    child.kill(process.platform === 'win32' ? undefined : signal);
  } catch {
    // A concurrent exit is already reaped by the registered onExit listener.
  }
}

function hasRestoredTerminal(rawIo: string): boolean {
  const entered = rawIo.lastIndexOf(terminalSequences.enterAltBuffer);
  const exited = rawIo.lastIndexOf(terminalSequences.exitAltBuffer);
  const hidden = rawIo.lastIndexOf(terminalSequences.hideCursor);
  const shown = rawIo.lastIndexOf(terminalSequences.showCursor);
  return entered >= 0 && exited > entered && (hidden < 0 || shown > hidden);
}

function hasComposerDraft(rawIo: string): boolean {
  const visible = stripTerminalControls(rawIo, { preserveLineBreaks: true });
  const prefix = escapeRegExp(PTY_APPROVAL_PREFIX);
  const suffix = escapeRegExp(PTY_APPROVAL_SUFFIX);
  return new RegExp(`› ${prefix}(?!${suffix})`, 'u').test(visible);
}

function hasCompletedComposerDraft(rawIo: string): boolean {
  const visible = stripTerminalControls(rawIo, { preserveLineBreaks: true });
  return visible.includes(`› ${PTY_APPROVAL_PREFIX}${PTY_APPROVAL_SUFFIX}`);
}

function readEditorPid(rawIo: string): number | undefined {
  const marker = escapeRegExp(PTY_EDITOR_STARTED_MARKER);
  const match = rawIo.match(new RegExp(`${marker}:(\\d+)`, 'u'));
  if (!match?.[1]) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid ? pid : undefined;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ptyError(name: string, message: string, cause?: unknown): Error {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.name = name;
  return error;
}
