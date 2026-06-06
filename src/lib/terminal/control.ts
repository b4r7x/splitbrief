export const terminalSequences = {
  exitAltBuffer: '\u001b[?1049l',
  showCursor: '\u001b[?25h',
  enableMouseTracking: '\u001b[?1000h',
  disableMouseTracking: '\u001b[?1000l',
  enableSgrMouse: '\u001b[?1006h',
  disableSgrMouse: '\u001b[?1006l',
  enableBracketedPaste: '\u001b[?2004h',
  disableBracketedPaste: '\u001b[?2004l',
} as const;

let stdoutErrorGuardInstalled = false;

export function isBrokenOutputError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'EPIPE';
}

export function installTerminalOutputErrorGuard(): void {
  if (stdoutErrorGuardInstalled) return;
  stdoutErrorGuardInstalled = true;
  process.stdout.on('error', (err: Error) => {
    if (isBrokenOutputError(err)) return;
    throw err;
  });
}

export function writeTerminalSequence(sequence: string): void {
  installTerminalOutputErrorGuard();
  try {
    process.stdout.write(sequence, (err?: Error | null) => {
      if (!err || isBrokenOutputError(err)) return;
      throw err;
    });
  } catch (err) {
    if (isBrokenOutputError(err)) return;
    throw err;
  }
}

export function setTerminalInputModes(enabled: boolean): void {
  writeTerminalSequence(
    enabled ? terminalSequences.enableMouseTracking : terminalSequences.disableMouseTracking,
  );
  writeTerminalSequence(
    enabled ? terminalSequences.enableSgrMouse : terminalSequences.disableSgrMouse,
  );
  writeTerminalSequence(
    enabled ? terminalSequences.enableBracketedPaste : terminalSequences.disableBracketedPaste,
  );
}

export function restoreTerminalControl(opts: {
  fullscreen: boolean;
  mouse: boolean;
  stdin?: NodeJS.ReadStream | undefined;
}): void {
  if (opts.mouse) setTerminalInputModes(false);
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
