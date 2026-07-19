import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ReactElement } from 'react';
import { render } from 'ink';
import {
  createFilteredStdin,
  getActiveFilteredStdin,
  setActiveFilteredStdin,
  type FilteredStdin,
} from '../../src/lib/terminal/filtered-stdin.js';

// Bridges raw terminal bytes through the real FilteredStdin (mouse filter +
// bracketed-paste stripper) into a real Ink render, the way src/cli/render.ts wires
// production: createFilteredStdin(process.stdin) -> render({ stdin: filtered.stdin }).
// Drive input via `pressBytes`.

export interface FilteredStdinViewport {
  readonly cols: number;
  readonly rows: number;
}

const DEFAULT_VIEWPORT: FilteredStdinViewport = { cols: 100, rows: 24 };

function makeCaptureStdout(viewport: FilteredStdinViewport) {
  let last: string | undefined;
  return Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: viewport.cols,
    rows: viewport.rows,
    write: (frame: string): boolean => {
      last = frame;
      return true;
    },
    lastFrame: (): string | undefined => last,
  });
}

function makeSourceStdin(): NodeJS.ReadStream {
  // Only bridge the TTY members createFilteredStdin reads. The stream's own read/flow
  // machinery must stay intact: the filter consumes the source via on('data', …), which
  // never fires if read()/resume()/pause() are stubbed out.
  const source = new PassThrough();
  Object.assign(source, {
    isTTY: true,
    isRaw: false,
    setRawMode: (mode: boolean) => {
      Object.assign(source, { isRaw: mode });
      return source;
    },
    ref: () => source,
    unref: () => source,
  });
  return source as unknown as NodeJS.ReadStream;
}

export interface FilteredStdinHarness {
  lastFrame: () => string | undefined;
  filtered: FilteredStdin;
  pressBytes: (bytes: string) => void;
  unmount: () => void;
}

export interface FilteredStdinHarnessDependencies {
  readonly render?: typeof render;
}

// Runs `fn` with process.stdout.write muted, so the mouse/paste enable/disable
// sequences createFilteredStdin / filtered.disable() write to the real terminal do
// not litter the test output. Restored in a finally even when `fn` throws.
function withMutedStdout<T>(fn: () => T): T {
  const realWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return fn();
  } finally {
    process.stdout.write = realWrite;
  }
}

export function renderThroughFilteredStdin(
  element: ReactElement,
  viewport: FilteredStdinViewport = DEFAULT_VIEWPORT,
  dependencies: FilteredStdinHarnessDependencies = {},
): FilteredStdinHarness {
  assertViewport(viewport);
  const stdout = makeCaptureStdout(viewport);
  const previousActiveFilteredStdin = getActiveFilteredStdin();

  const { source, filtered, instance } = withMutedStdout(() => {
    const source = makeSourceStdin();
    const filtered = createFilteredStdin(source);
    try {
      setActiveFilteredStdin(filtered);
      const instance = (dependencies.render ?? render)(element, {
        stdin: filtered.stdin,
        // Frame-capture stream that mirrors ink-testing-library's fake stdout; the cast is
        // the interop boundary, the same shape Ink writes rendered frames to.
        stdout: stdout as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      });
      return { source, filtered, instance };
    } catch (error) {
      try {
        filtered.disable();
      } finally {
        setActiveFilteredStdin(previousActiveFilteredStdin);
      }
      throw error;
    }
  });

  let mounted = true;
  return {
    lastFrame: stdout.lastFrame,
    filtered,
    pressBytes: (bytes: string) => {
      source.write(Buffer.from(bytes, 'utf8'));
    },
    unmount: () => {
      if (!mounted) return;
      mounted = false;
      try {
        withMutedStdout(() => {
          try {
            instance.unmount();
          } finally {
            filtered.disable();
          }
        });
      } finally {
        setActiveFilteredStdin(previousActiveFilteredStdin);
      }
    },
  };
}

function assertViewport(viewport: FilteredStdinViewport): void {
  if (
    !Number.isInteger(viewport.cols) ||
    viewport.cols <= 0 ||
    !Number.isInteger(viewport.rows) ||
    viewport.rows <= 0
  ) {
    throw new Error('Filtered stdin viewport must contain positive integer cols and rows');
  }
}
