import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ReactElement } from 'react';
import { render } from 'ink';
import {
  createFilteredStdin,
  setActiveFilteredStdin,
  type FilteredStdin,
} from '../../src/lib/terminal/filtered-stdin.js';

// Bridges raw terminal bytes through the real FilteredStdin (mouse filter +
// bracketed-paste stripper) into a real Ink render, the way src/cli/render.ts wires
// production: createFilteredStdin(process.stdin) -> render({ stdin: filtered.stdin }).
// Drive input via `pressBytes`.

function makeCaptureStdout() {
  let last: string | undefined;
  return Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 100,
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

// Runs `fn` with process.stdout.write muted, so the mouse/paste enable/disable
// sequences createFilteredStdin / filtered.disable() write to the real terminal do
// not litter the test output. Restored in a finally even when `fn` throws.
function withMutedStdout<T>(fn: () => T): T {
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return fn();
  } finally {
    process.stdout.write = realWrite;
  }
}

export function renderThroughFilteredStdin(element: ReactElement): FilteredStdinHarness {
  const stdout = makeCaptureStdout();

  const { source, filtered, instance } = withMutedStdout(() => {
    const source = makeSourceStdin();
    const filtered = createFilteredStdin(source);
    setActiveFilteredStdin(filtered);
    const instance = render(element, {
      stdin: filtered.stdin,
      // Frame-capture stream that mirrors ink-testing-library's fake stdout; the cast is
      // the interop boundary, the same shape Ink writes rendered frames to.
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    });
    return { source, filtered, instance };
  });

  return {
    lastFrame: stdout.lastFrame,
    filtered,
    pressBytes: (bytes: string) => {
      source.write(Buffer.from(bytes, 'utf8'));
    },
    unmount: () => {
      withMutedStdout(() => {
        instance.unmount();
        filtered.disable();
      });
      setActiveFilteredStdin(undefined);
    },
  };
}
