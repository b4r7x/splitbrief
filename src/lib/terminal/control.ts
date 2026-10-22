import { warnError } from '../warn.js';

export const terminalSequences = {
  enterAltBuffer: '\u001b[?1049h',
  exitAltBuffer: '\u001b[?1049l',
  hideCursor: '\u001b[?25l',
  showCursor: '\u001b[?25h',
  enableButtonEventMouse: '\u001b[?1002h',
  disableMouseTracking: '\u001b[?1000l',
  disableButtonEventMouse: '\u001b[?1002l',
  enableAnyMotionMouse: '\u001b[?1003h',
  disableAnyMotionMouse: '\u001b[?1003l',
  enableSgrMouse: '\u001b[?1006h',
  disableSgrMouse: '\u001b[?1006l',
  enableBracketedPaste: '\u001b[?2004h',
  disableBracketedPaste: '\u001b[?2004l',
  popKittyKeyboard: '\u001b[<u',
  eraseDown: '\u001b[J',
} as const;

export function cursorUpSequence(rows: number): string {
  return `\u001b[${rows}A`;
}

let outputErrorGuardInstalled = false;

export function isBrokenOutputError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'EPIPE';
}

export function installTerminalOutputErrorGuard(): void {
  if (outputErrorGuardInstalled) return;
  outputErrorGuardInstalled = true;
  const guard = (err: Error) => {
    if (isBrokenOutputError(err)) return;
    throw err;
  };
  process.stdout.on('error', guard);
  process.stderr.on('error', guard);
  // Ink's restore-cursor dependency writes to stderr at process exit, even when stdout owns the TUI.
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ) => {
    const write =
      chunk === terminalSequences.showCursor
        ? process.stdout.write.bind(process.stdout)
        : stderrWrite;
    return typeof encodingOrCallback === 'string'
      ? write(chunk, encodingOrCallback, callback)
      : write(chunk, encodingOrCallback ?? callback);
  };
}

// Returns whether the sequence was handed to stdout without a synchronous failure. A broken pipe
// (stdout closed, e.g. the reader went away) yields `false` so a clipboard caller can downgrade an
// OSC-52 emit it can never otherwise confirm. Asynchronous write failures still only warn — they
// cannot influence this synchronous result, which is the honest limit of a fire-and-forget write.
export function writeTerminalSequence(sequence: string): boolean {
  installTerminalOutputErrorGuard();
  try {
    process.stdout.write(sequence, (err?: Error | null) => {
      if (!err || isBrokenOutputError(err)) return;
      warnError('writeTerminalSequence: stdout write failed', err);
    });
    return true;
  } catch (err) {
    if (isBrokenOutputError(err)) return false;
    throw err;
  }
}

export interface TerminalInputModeOptions {
  mouse?: boolean | undefined;
  paste?: boolean | undefined;
  hover?: boolean | undefined;
}

export function setTerminalInputModes(
  mode: 'enable' | 'disable',
  opts?: TerminalInputModeOptions,
): void {
  const enabled = mode === 'enable';
  const mouse = opts?.mouse ?? true;
  const paste = opts?.paste ?? true;
  const hover = opts?.hover ?? false;
  if (mouse) {
    if (enabled) {
      writeTerminalSequence(
        hover ? terminalSequences.enableAnyMotionMouse : terminalSequences.enableButtonEventMouse,
      );
      writeTerminalSequence(terminalSequences.enableSgrMouse);
    } else {
      writeTerminalSequence(terminalSequences.disableMouseTracking);
      writeTerminalSequence(terminalSequences.disableButtonEventMouse);
      writeTerminalSequence(terminalSequences.disableAnyMotionMouse);
      writeTerminalSequence(terminalSequences.disableSgrMouse);
    }
  }
  if (paste) {
    writeTerminalSequence(
      enabled ? terminalSequences.enableBracketedPaste : terminalSequences.disableBracketedPaste,
    );
  }
}

export function restoreTerminalControl(opts: {
  fullscreen: boolean;
  mouse: boolean;
  paste?: boolean | undefined;
  stdin?: NodeJS.ReadStream | undefined;
}): void {
  const paste = opts.paste ?? opts.mouse;
  if (opts.mouse || paste) setTerminalInputModes('disable', { mouse: opts.mouse, paste });
  if (opts.fullscreen) {
    writeTerminalSequence(terminalSequences.exitAltBuffer);
    writeTerminalSequence(terminalSequences.showCursor);
  }
  const stdin = opts.stdin ?? process.stdin;
  if (!stdin.isTTY) return;
  try {
    stdin.setRawMode(false);
  } catch {
    // terminal may already be detached during signal shutdown
  }
}
