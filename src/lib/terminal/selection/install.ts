import XtermHeadless from '@xterm/headless';
import { UnicodeGraphemesAddon } from './grapheme-addon.js';
import type { CopyOutcome } from '../../clipboard/copy.js';
import type { MouseDispatch, MouseEvent } from '../filtered-stdin/types.js';
import { filterInput } from './copy.js';
import { handleMouse } from './gesture.js';
import { clear, flushOutput, handleResize, interceptWrite, resume, suspend } from './output.js';
import type { SelectionState } from './types.js';

export interface TerminalSelection {
  handleMouse: (event: MouseEvent, dispatch: MouseDispatch) => void;
  filterInput: (text: string) => string;
  clear: () => void;
  suspend: () => void;
  resume: () => void;
  dispose: () => void;
}

/** Mirrors clean output; only the visible viewport is retained. Selection never enters the mirror. */
export function installTerminalSelection(options: {
  stdout: NodeJS.WriteStream;
  copy: (text: string) => Promise<CopyOutcome>;
  reportError: (message: string) => void;
  onCopyKey?: ((result: Promise<CopyOutcome | undefined>) => void) | undefined;
}): TerminalSelection {
  const { stdout } = options;
  const terminal = new XtermHeadless.Terminal({
    cols: stdout.columns,
    rows: stdout.rows,
    allowProposedApi: true,
    // Ink writes LF; the TTY expands it to CRLF after this interception boundary.
    convertEol: true,
    scrollback: 0,
    logLevel: 'off',
    disableStdin: true,
  });
  terminal.loadAddon(new UnicodeGraphemesAddon());
  const originalWrite = stdout.write;
  const state: SelectionState = {
    stdout,
    terminal,
    writeOriginal: originalWrite.bind(stdout),
    copy: options.copy,
    reportError: options.reportError,
    onCopyKey: options.onCopyKey,
    gesture: undefined,
    disposed: false,
    suspended: false,
    repainting: false,
    writeRevision: 0,
    lifecycleRevision: 0,
    parsedAlternateExit: false,
    copyQueue: Promise.resolve(),
    pendingOutput: [],
  };

  const onResize = () => handleResize(state);
  stdout.on('resize', onResize);

  // fullscreen-ink can leave the alternate buffer before our owner's cleanup runs.
  // Let xterm recognize fragmented DECRST. Owner cleanup restores cursor and input modes.
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (params.includes(1049)) state.parsedAlternateExit = true;
    return false;
  });

  const intercept: typeof stdout.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => interceptWrite(state, chunk, encodingOrCallback, callback);
  stdout.write = intercept;

  return {
    handleMouse: (event, dispatch) => handleMouse(state, event, dispatch),
    filterInput: (text) => filterInput(state, text),
    clear: () => clear(state),
    suspend: () => suspend(state),
    resume: () => resume(state),
    dispose: () => {
      if (state.disposed) return;
      state.disposed = true;
      state.gesture = undefined;
      flushOutput(state);
      stdout.off('resize', onResize);
      if (stdout.write === intercept) stdout.write = originalWrite;
      terminal.dispose();
    },
  };
}
