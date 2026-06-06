import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import {
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

    setTerminalInputModes(true);
    setTerminalInputModes(false);

    expect(written).toEqual([
      terminalSequences.enableMouseTracking,
      terminalSequences.enableSgrMouse,
      terminalSequences.enableBracketedPaste,
      terminalSequences.disableMouseTracking,
      terminalSequences.disableSgrMouse,
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
      terminalSequences.disableSgrMouse,
      terminalSequences.disableBracketedPaste,
      terminalSequences.exitAltBuffer,
      terminalSequences.showCursor,
    ]);
    expect(rawModes).toEqual([false]);
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
});
