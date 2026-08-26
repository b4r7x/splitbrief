import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { terminalSequences } from './control.js';
import {
  resumeTerminalAfterEditor,
  setActiveTerminalHandover,
  suspendTerminalForEditor,
  type TerminalHandoverConfig,
} from './editor-handover.js';

type HandoverSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGTSTP' | 'SIGCONT';

const HANDOVER_SIGNALS: readonly HandoverSignal[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGTSTP',
  'SIGCONT',
];

let originalWrite: typeof process.stdout.write;

function shouldHaveMask(signal: HandoverSignal): boolean {
  return signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGHUP';
}

function makeFakeStdin(raw = false) {
  const calls: string[] = [];
  const rawModes: boolean[] = [];
  const stdin = {
    isRaw: raw,
    pause: () => {
      calls.push('pause');
      return stdin;
    },
    resume: () => {
      calls.push('resume');
      return stdin;
    },
    setRawMode: (mode: boolean) => {
      rawModes.push(mode);
      stdin.isRaw = mode;
      return stdin;
    },
  };
  return { stdin, calls, rawModes };
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
  // Every suspend/resume writes real cursor sequences; swallow them by default so tests
  // that never call captureStdout() don't leak ANSI codes into the test terminal.
  process.stdout.write = (() => true) as typeof process.stdout.write;
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
    expect(suspendWrites.indexOf(terminalSequences.showCursor)).toBeGreaterThan(
      suspendWrites.indexOf(terminalSequences.exitAltBuffer),
    );

    expect(resumeWrites).toContain(terminalSequences.enterAltBuffer);
    expect(resumeWrites).toContain(terminalSequences.enableMouseTracking);
    expect(resumeWrites).not.toContain(terminalSequences.showCursor);
    expect(resumeWrites.indexOf(terminalSequences.hideCursor)).toBeGreaterThan(
      resumeWrites.indexOf(terminalSequences.enterAltBuffer),
    );

    expect(calls).toEqual(['pause', 'resume']);
  });

  it('re-hides the hardware cursor on resume for a non-fullscreen handover', () => {
    const { stdin } = makeFakeStdin();
    const config: TerminalHandoverConfig = { fullscreen: false, mouse: false, sourceStdin: stdin };
    const written = captureStdout();

    suspendTerminalForEditor(config);
    const afterSuspend = written.length;
    resumeTerminalAfterEditor(config);

    expect(written.slice(0, afterSuspend)).toContain(terminalSequences.showCursor);
    expect(written.slice(afterSuspend)).toContain(terminalSequences.hideCursor);
    expect(written).not.toContain(terminalSequences.enterAltBuffer);
    expect(written).not.toContain(terminalSequences.exitAltBuffer);
  });

  it('resumes hover-enabled handoffs with any-motion mouse tracking', () => {
    const { stdin } = makeFakeStdin();
    const config: TerminalHandoverConfig = {
      fullscreen: true,
      mouse: true,
      hover: true,
      sourceStdin: stdin,
    };
    const written = captureStdout();

    suspendTerminalForEditor(config);
    const afterSuspend = written.length;
    resumeTerminalAfterEditor(config);

    const resumeWrites = written.slice(afterSuspend);

    expect(resumeWrites).toContain(terminalSequences.enableAnyMotionMouse);
    expect(resumeWrites).not.toContain(terminalSequences.enableMouseTracking);
  });

  it('brackets paste mode without mouse tracking when mouse is disabled', () => {
    const { stdin, calls } = makeFakeStdin();
    const config: TerminalHandoverConfig = {
      fullscreen: true,
      mouse: false,
      paste: true,
      sourceStdin: stdin,
    };
    const written = captureStdout();

    suspendTerminalForEditor(config);
    const afterSuspend = written.length;
    resumeTerminalAfterEditor(config);

    const suspendWrites = written.slice(0, afterSuspend);
    const resumeWrites = written.slice(afterSuspend);

    expect(suspendWrites).toContain(terminalSequences.disableBracketedPaste);
    expect(suspendWrites).not.toContain(terminalSequences.disableMouseTracking);
    expect(resumeWrites).toContain(terminalSequences.enableBracketedPaste);
    expect(resumeWrites).not.toContain(terminalSequences.enableMouseTracking);
    expect(calls).toEqual(['pause', 'resume']);
  });

  it('disables source stdin raw mode for the handoff and restores it afterward', () => {
    const { stdin, rawModes } = makeFakeStdin(true);
    const config: TerminalHandoverConfig = { fullscreen: false, mouse: false, sourceStdin: stdin };

    suspendTerminalForEditor(config);
    expect(stdin.isRaw).toBe(false);

    resumeTerminalAfterEditor(config);

    expect(stdin.isRaw).toBe(true);
    expect(rawModes).toEqual([false, true]);
  });

  it('leaves raw mode untouched when source stdin was not raw', () => {
    const { stdin, rawModes } = makeFakeStdin(false);
    const config: TerminalHandoverConfig = { fullscreen: false, mouse: false, sourceStdin: stdin };

    suspendTerminalForEditor(config);
    resumeTerminalAfterEditor(config);

    expect(stdin.isRaw).toBe(false);
    expect(rawModes).toEqual([]);
  });

  it('masks parent signal handlers during handoff and restores them afterward', () => {
    const { stdin } = makeFakeStdin();
    const config: TerminalHandoverConfig = { fullscreen: false, mouse: false, sourceStdin: stdin };
    const handledSignals: HandoverSignal[] = [];
    const testHandlers = HANDOVER_SIGNALS.map((signal) => {
      const listener: NodeJS.SignalsListener = () => {
        handledSignals.push(signal);
      };
      process.on(signal, listener);
      return { signal, listener };
    });
    const before = HANDOVER_SIGNALS.map((signal) => ({
      signal,
      listeners: process.listeners(signal),
    }));
    let suspended = false;

    try {
      suspendTerminalForEditor(config);
      suspended = true;

      for (const { signal, listener } of testHandlers) {
        const listeners = process.listeners(signal);
        expect(listeners).not.toContain(listener);
        expect(listeners).toHaveLength(shouldHaveMask(signal) ? 1 : 0);
        process.emit(signal, signal);
      }
      expect(handledSignals).toEqual([]);

      resumeTerminalAfterEditor(config);
      suspended = false;

      for (const snapshot of before) {
        expect(process.listeners(snapshot.signal)).toEqual(snapshot.listeners);
      }
    } finally {
      if (suspended) resumeTerminalAfterEditor(config);
      for (const { signal, listener } of testHandlers) process.off(signal, listener);
    }
  });

  it('skips alt-buffer and mouse sequences when no handover is active but still pauses stdin', () => {
    const { stdin, calls } = makeFakeStdin();
    setActiveTerminalHandover(undefined);
    const written = captureStdout();

    suspendTerminalForEditor({ fullscreen: false, mouse: false, sourceStdin: stdin });
    resumeTerminalAfterEditor({ fullscreen: false, mouse: false, sourceStdin: stdin });

    expect(written).toEqual([terminalSequences.showCursor, terminalSequences.hideCursor]);
    expect(calls).toEqual(['pause', 'resume']);
  });

  it('falls back to process.stdin pause/resume when no handover is configured', () => {
    const written = captureStdout();
    const pause = process.stdin.pause;
    const resume = process.stdin.resume;
    const calls: string[] = [];
    process.stdin.pause = (() => {
      calls.push('pause');
      return process.stdin;
    }) as typeof process.stdin.pause;
    process.stdin.resume = (() => {
      calls.push('resume');
      return process.stdin;
    }) as typeof process.stdin.resume;

    try {
      suspendTerminalForEditor();
      resumeTerminalAfterEditor();

      // Even without a handover config the cursor round-trips: shown for the editor,
      // re-hidden the moment the TUI takes the screen back.
      expect(written).toEqual([terminalSequences.showCursor, terminalSequences.hideCursor]);
      expect(calls).toEqual(['pause', 'resume']);
    } finally {
      process.stdin.pause = pause;
      process.stdin.resume = resume;
    }
  });
});
