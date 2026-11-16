import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ReactElement } from 'react';
import { render } from 'ink';
import { InputTurns } from '../../src/cli/render/input-turns.js';
import { createFilteredStdin } from '../../src/lib/terminal/filtered-stdin/create.js';
import {
  getActiveFilteredStdin,
  setActiveFilteredStdin,
} from '../../src/lib/terminal/filtered-stdin/active.js';
import type { FilteredStdin, InputHold } from '../../src/lib/terminal/filtered-stdin/types.js';
import { flushEffects, tick } from './ink.js';

// Bridges raw terminal bytes through the real FilteredStdin (mouse filter +
// bracketed-paste stripper) into a real Ink render, the way src/cli/render/stdin.ts and
// src/cli/render/mount.ts wire production: createFilteredStdin(process.stdin) ->
// render({ stdin: filtered.stdin }).
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
  /** Resolves once the bridge holds no input and the app has taken the last of it. */
  settled: () => Promise<void>;
  /** The count of turns that the bridge asked for since the mount. */
  turns: () => number;
  unmount: () => void;
}

export interface FilteredStdinHarnessDependencies {
  readonly render?: typeof render;
  /**
   * False models a terminal that gives no answer to the bracketed paste query of the bridge. By
   * default the terminal answers that it brackets a paste, as tmux and xterm.js do.
   */
  readonly terminalAnswers?: boolean;
}

// The reply of a terminal that has bracketed paste on, to the query that the bridge sends.
const BRACKETED_PASTE_REPLY = '\u001b[?2004;1$y';

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
  const turns = { open: 0, taken: 0 };

  const { source, filtered, instance } = withMutedStdout(() => {
    const source = makeSourceStdin();
    const filtered = createFilteredStdin(source);
    if (dependencies.terminalAnswers !== false) source.write(Buffer.from(BRACKETED_PASTE_REPLY));
    try {
      setActiveFilteredStdin(filtered);
      // The production turns, counted: the bridge asks one turn for each input it gives on, and
      // one for a row of wheel steps that only write a store.
      const holdInput = (hold: InputHold) =>
        filtered.holdInput((release) => {
          turns.open += 1;
          turns.taken += 1;
          hold(() => {
            turns.open -= 1;
            release();
          });
        });
      const paced = (
        <>
          {element}
          <InputTurns holdInput={holdInput} />
        </>
      );
      const instance = (dependencies.render ?? render)(paced, {
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
    settled: async () => {
      while (turns.open > 0) await tick();
      await flushEffects();
    },
    turns: () => turns.taken,
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
