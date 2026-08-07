import { EventEmitter } from 'node:events';
import { render } from 'ink';
import type { ReactElement } from 'react';

export interface RenderViewport {
  readonly cols: number;
  readonly rows: number;
}

export const DEFAULT_RENDER_VIEWPORT: RenderViewport = { cols: 100, rows: 24 };

export interface RenderFeatureResult {
  lastFrame: () => string;
  frames: string[];
  unmount: () => void;
  stdin: { write: (data: string) => void };
  rerender: (element: ReactElement) => void;
}

// Capture streams that mirror the replaced library's fakes (EventEmitter +
// Object.assign, never a class). The caller chooses the layout width because Ink's
// root width is options.stdout.columns; the library's fixed 100-column getter is what
// made every renderFeature mount lay out at the wrong width on wider viewports.

function makeCaptureStdout(viewport: RenderViewport) {
  const frames: string[] = [];
  let last: string | undefined;
  const stream = Object.assign(new EventEmitter(), {
    columns: viewport.cols,
    write: (frame: string): boolean => {
      frames.push(frame);
      last = frame;
      return true;
    },
  });
  return {
    frames,
    lastFrame: (): string => last ?? '',
    stream,
  };
}

function makeCaptureStderr() {
  const frames: string[] = [];
  return Object.assign(new EventEmitter(), {
    write: (frame: string): boolean => {
      frames.push(frame);
      return true;
    },
  });
}

function makeCaptureStdin() {
  let data: string | null = null;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    write: (chunk: string): void => {
      data = chunk;
      stdin.emit('readable');
      stdin.emit('data', chunk);
    },
    read: (): string | null => {
      const pending = data;
      data = null;
      return pending;
    },
    setEncoding: (): void => {},
    setRawMode: (): void => {},
    resume: (): void => {},
    pause: (): void => {},
    ref: (): void => {},
    unref: (): void => {},
  });
  return stdin;
}

export function renderFeature(
  element: ReactElement,
  viewport: RenderViewport = DEFAULT_RENDER_VIEWPORT,
): RenderFeatureResult {
  const stdout = makeCaptureStdout(viewport);
  const stdin = makeCaptureStdin();
  const instance = render(element, {
    // Interop boundary: the capture streams satisfy the TTY members Ink reads, the
    // same shape the filtered-stdin harness passes as streams.
    stdout: stdout.stream as unknown as NodeJS.WriteStream,
    stderr: makeCaptureStderr() as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    lastFrame: stdout.lastFrame,
    frames: stdout.frames,
    unmount: instance.unmount,
    stdin: { write: (data: string) => stdin.write(data) },
    rerender: instance.rerender,
  };
}

export function tick(ms = 0): Promise<void> {
  if (ms > 0) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

// React on Node schedules renders and passive effects via setImmediate, and expired
// timers run before the check phase when a starved process wakes, so a timer-based
// tick(ms) can resume the test before Ink's useInput has (re)subscribed and the next
// stdin.write lands on a stale or absent handler. Awaiting setImmediate turns queues
// behind that pending work: turn 1 covers the render+commit, turn 2 the passive-effect
// flush it schedules, turn 3 is margin. Await this before each stdin.write.
export async function flushEffects(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await tick();
  }
}
