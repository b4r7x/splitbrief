import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  installTerminalOutputErrorGuard,
  isBrokenOutputError,
  restoreTerminalControl,
  setTerminalInputModes,
  terminalSequences,
  writeTerminalSequence,
} from './control.js';

type WriteCallback = (err?: Error | null) => void;

let originalWrite: typeof process.stdout.write;

function callbackFromWriteArgs(
  encodingOrCallback: BufferEncoding | WriteCallback | undefined,
  callback: WriteCallback | undefined,
): WriteCallback | undefined {
  return typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
}

function createEpipeError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('write EPIPE');
  err.code = 'EPIPE';
  return err;
}

function makeFakeStdin() {
  const stdin = new PassThrough();
  const rawModes: boolean[] = [];
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: (mode: boolean) => {
      rawModes.push(mode);
      return stdin;
    },
  });
  return { stdin: stdin as unknown as NodeJS.ReadStream, rawModes };
}

describe('terminal control', () => {
  beforeEach(() => {
    originalWrite = process.stdout.write.bind(process.stdout);
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('writes terminal input mode enable and disable sequences', () => {
    const written: string[] = [];
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    setTerminalInputModes('enable');
    setTerminalInputModes('disable');

    expect(written).toEqual([
      terminalSequences.enableMouseTracking,
      terminalSequences.enableSgrMouse,
      terminalSequences.enableBracketedPaste,
      terminalSequences.disableMouseTracking,
      terminalSequences.disableButtonEventMouse,
      terminalSequences.disableAnyMotionMouse,
      terminalSequences.disableSgrMouse,
      terminalSequences.disableBracketedPaste,
    ]);
  });

  it('enables any-motion tracking when hover is requested', () => {
    const written: string[] = [];
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    setTerminalInputModes('enable', { mouse: true, paste: false, hover: true });

    expect(written).toEqual([
      terminalSequences.enableAnyMotionMouse,
      terminalSequences.enableSgrMouse,
    ]);
  });

  it('can enable and disable bracketed paste without mouse tracking', () => {
    const written: string[] = [];
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    setTerminalInputModes('enable', { mouse: false, paste: true });
    setTerminalInputModes('disable', { mouse: false, paste: true });

    expect(written).toEqual([
      terminalSequences.enableBracketedPaste,
      terminalSequences.disableBracketedPaste,
    ]);
  });

  it('restores fullscreen, mouse, paste, and raw terminal modes', () => {
    const written: string[] = [];
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    const { stdin, rawModes } = makeFakeStdin();

    restoreTerminalControl({ fullscreen: true, mouse: true, stdin });

    expect(written).toEqual([
      terminalSequences.disableMouseTracking,
      terminalSequences.disableButtonEventMouse,
      terminalSequences.disableAnyMotionMouse,
      terminalSequences.disableSgrMouse,
      terminalSequences.disableBracketedPaste,
      terminalSequences.exitAltBuffer,
      terminalSequences.showCursor,
    ]);
    expect(rawModes).toEqual([false]);
  });

  it('can restore paste mode without restoring mouse mode', () => {
    const written: string[] = [];
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    const { stdin } = makeFakeStdin();

    restoreTerminalControl({ fullscreen: false, mouse: false, paste: true, stdin });

    expect(written).toEqual([terminalSequences.disableBracketedPaste]);
  });

  it('ignores synchronous broken-pipe writes', () => {
    const err = createEpipeError();
    process.stdout.write = (() => {
      throw err;
    }) as typeof process.stdout.write;

    expect(() => writeTerminalSequence(terminalSequences.showCursor)).not.toThrow();
    expect(isBrokenOutputError(err)).toBe(true);
  });

  it('guards asynchronous broken-pipe error events', () => {
    const err = createEpipeError();
    process.stdout.write = ((
      _chunk: string,
      encodingOrCallback?: BufferEncoding | WriteCallback,
      callback?: WriteCallback,
    ) => {
      callbackFromWriteArgs(encodingOrCallback, callback)?.(err);
      return false;
    }) as typeof process.stdout.write;

    writeTerminalSequence(terminalSequences.showCursor);

    expect(() => process.stdout.emit('error', err)).not.toThrow();
  });

  it('warns instead of crashing when the async write callback reports a non-pipe error', () => {
    const fatal: NodeJS.ErrnoException = new Error('write ENOSPC');
    fatal.code = 'ENOSPC';
    const warnings: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      warnings.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((
      _chunk: string,
      encodingOrCallback?: BufferEncoding | WriteCallback,
      callback?: WriteCallback,
    ) => {
      callbackFromWriteArgs(encodingOrCallback, callback)?.(fatal);
      return false;
    }) as typeof process.stdout.write;

    try {
      expect(() => writeTerminalSequence(terminalSequences.showCursor)).not.toThrow();
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    expect(warnings.join('')).toContain('write ENOSPC');
  });

  it('swallows broken-pipe error events on both stdout and stderr', () => {
    installTerminalOutputErrorGuard();
    const epipe = createEpipeError();

    expect(() => process.stdout.emit('error', epipe)).not.toThrow();
    expect(() => process.stderr.emit('error', epipe)).not.toThrow();
  });

  it('re-raises non-broken-pipe stderr error events', () => {
    installTerminalOutputErrorGuard();
    const fatal: NodeJS.ErrnoException = new Error('write ENOSPC');
    fatal.code = 'ENOSPC';

    expect(() => process.stderr.emit('error', fatal)).toThrow('write ENOSPC');
  });
});
