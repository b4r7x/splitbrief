import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { terminalSequences } from './control.js';
import {
  resumeTerminalAfterEditor,
  setActiveTerminalHandover,
  suspendTerminalForEditor,
  type TerminalHandoverConfig,
} from './editor-handover.js';

let originalWrite: typeof process.stdout.write;

function makeFakeStdin() {
  const stdin = new PassThrough();
  const calls: string[] = [];
  Object.assign(stdin, {
    pause: () => {
      calls.push('pause');
      return stdin;
    },
    resume: () => {
      calls.push('resume');
      return stdin;
    },
  });
  return { stdin: stdin as unknown as NodeJS.ReadStream, calls };
}

function captureStdout(): string[] {
  const written: string[] = [];
  process.stdout.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  return written;
}

beforeEach(() => {
  originalWrite = process.stdout.write.bind(process.stdout);
  setActiveTerminalHandover(undefined);
});

afterEach(() => {
  process.stdout.write = originalWrite;
  setActiveTerminalHandover(undefined);
});

describe('terminal handover for $EDITOR', () => {
  it('brackets the editor with disable-then-restore sequences in fullscreen mouse mode', () => {
    const { stdin, calls } = makeFakeStdin();
    const config: TerminalHandoverConfig = { fullscreen: true, mouse: true, sourceStdin: stdin };
    setActiveTerminalHandover(config);
    const written = captureStdout();

    suspendTerminalForEditor();
    const afterSuspend = written.length;
    resumeTerminalAfterEditor();

    const suspendWrites = written.slice(0, afterSuspend);
    const resumeWrites = written.slice(afterSuspend);

    expect(suspendWrites).toContain(terminalSequences.popKittyKeyboard);
    expect(suspendWrites).toContain(terminalSequences.exitAltBuffer);
    expect(suspendWrites).toContain(terminalSequences.disableMouseTracking);
    expect(suspendWrites).not.toContain(terminalSequences.enterAltBuffer);

    expect(resumeWrites).toContain(terminalSequences.enterAltBuffer);
    expect(resumeWrites).toContain(terminalSequences.enableMouseTracking);

    expect(calls).toEqual(['pause', 'resume']);
  });

  it('skips alt-buffer and mouse sequences when no handover is active but still pauses stdin', () => {
    const { stdin } = makeFakeStdin();
    setActiveTerminalHandover(undefined);
    const written = captureStdout();

    suspendTerminalForEditor({ fullscreen: false, mouse: false, sourceStdin: stdin });
    resumeTerminalAfterEditor({ fullscreen: false, mouse: false, sourceStdin: stdin });

    expect(written).not.toContain(terminalSequences.exitAltBuffer);
    expect(written).not.toContain(terminalSequences.enterAltBuffer);
    expect(written).not.toContain(terminalSequences.disableMouseTracking);
  });

  it('falls back to process.stdin pause/resume when no handover is configured', () => {
    const written = captureStdout();

    suspendTerminalForEditor();
    resumeTerminalAfterEditor();

    expect(written).toHaveLength(0);
  });
});
