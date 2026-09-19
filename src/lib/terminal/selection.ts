import XtermHeadless from '@xterm/headless';
import { UnicodeGraphemesAddon } from './grapheme-addon.js';
import type { CopyOutcome } from '../clipboard/clipboard.js';
import type { MouseEvent, MouseListener } from './filtered-stdin/types.js';
import {
  renderSelection,
  selectionText,
  snapshotTerminalFrame,
  type SelectionPoint,
  type TerminalFrame,
} from './selection-frame.js';

interface SelectionGesture {
  phase: 'pressed' | 'dragging' | 'selected';
  anchor: SelectionPoint;
  focus: SelectionPoint;
  frame: Promise<TerminalFrame | undefined>;
  painted?: { anchor: SelectionPoint; focus: SelectionPoint };
}

export interface TerminalSelection {
  handleMouse: (event: MouseEvent, dispatch: MouseListener) => void;
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
}): TerminalSelection {
  const { stdout, copy, reportError } = options;
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
  const writeOriginal = originalWrite.bind(stdout);
  let gesture: SelectionGesture | undefined;
  let disposed = false;
  let suspended = false;
  let repainting = false;
  let writeRevision = 0;
  let lifecycleRevision = 0;
  let parsedAlternateExit = false;
  let copyQueue = Promise.resolve();
  let pendingOutput: {
    data: Buffer;
    callback: ((error?: Error | null) => void) | undefined;
  }[] = [];

  function flushOutput(highlight = ''): void {
    const pending = pendingOutput;
    pendingOutput = [];
    if (pending.length === 0 && highlight.length === 0) return;
    // Ink emits each synchronized-output terminator as a separate write. Defer those
    // complete writes until the highlight is included, even when several frames coalesce.
    const endSynchronizedOutput = Buffer.from('\u001b[?2026l');
    const writes = pending.map((write) => write.data);
    const deferEnd =
      highlight.length > 0 && writes.some((data) => data.equals(endSynchronizedOutput));
    const content = deferEnd
      ? writes.filter((data) => !data.equals(endSynchronizedOutput))
      : writes;
    const data = Buffer.concat([
      ...content,
      Buffer.from(highlight),
      ...(deferEnd ? [endSynchronizedOutput] : []),
    ]);
    writeOriginal(data, (error) => {
      for (const write of pending) write.callback?.(error);
    });
  }

  function redraw(): void {
    if (disposed || suspended) return;
    repainting = true;
    try {
      // Ink 6 fullscreen repaints on resize, including unchanged content and OSC 8 links.
      stdout.emit('resize');
    } finally {
      repainting = false;
    }
  }

  function clear(): void {
    if (!gesture) return;
    gesture = undefined;
    flushOutput();
    redraw();
  }

  function suspend(): void {
    suspended = true;
    gesture = undefined;
    writeRevision++;
    lifecycleRevision++;
    flushOutput();
  }

  const onResize = () => {
    if (repainting) return;
    gesture = undefined;
    writeRevision++;
    flushOutput();
    terminal.resize(stdout.columns, stdout.rows);
  };
  stdout.on('resize', onResize);

  // fullscreen-ink can leave the alternate buffer before our owner's cleanup runs.
  // Let xterm recognize fragmented DECRST. Owner cleanup restores cursor and input modes.
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (params.includes(1049)) parsedAlternateExit = true;
    return false;
  });

  function reconcile(current: SelectionGesture, revision: number): void {
    void current.frame.then((original) => {
      if (
        !original ||
        disposed ||
        suspended ||
        gesture !== current ||
        current.phase !== 'selected' ||
        revision !== writeRevision
      )
        return;
      const latest = snapshotTerminalFrame(terminal);
      if (
        selectionText(latest, current.anchor, current.focus) !==
        selectionText(original, current.anchor, current.focus)
      ) {
        clear();
        return;
      }
      // Flush the clean repaint and its highlight together, so clock/stream updates never
      // expose an unhighlighted frame while the asynchronous parser catches up.
      flushOutput(renderSelection(latest, current.anchor, current.focus));
    });
  }

  const interceptWrite: typeof stdout.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const forward = () =>
      typeof encodingOrCallback === 'string'
        ? writeOriginal(chunk, encodingOrCallback, callback)
        : writeOriginal(chunk, encodingOrCallback ?? callback);
    if (suspended || disposed) return forward();
    const data =
      typeof chunk === 'string' && typeof encodingOrCallback === 'string'
        ? Buffer.from(chunk, encodingOrCallback)
        : chunk;
    const revision = ++writeRevision;
    const lifecycle = lifecycleRevision;
    const withheld = gesture !== undefined && gesture.phase !== 'selected';
    const selected = gesture?.phase === 'selected';
    if (selected) {
      pendingOutput.push({
        data: Buffer.from(data),
        callback: typeof encodingOrCallback === 'function' ? encodingOrCallback : callback,
      });
    }
    terminal.write(data, () => {
      const exited = parsedAlternateExit;
      parsedAlternateExit = false;
      if (disposed || lifecycle !== lifecycleRevision) return;
      if (exited) {
        if (withheld) writeOriginal('\u001b[?1049l');
        suspend();
        return;
      }
      if (gesture?.phase === 'selected' && revision === writeRevision) {
        reconcile(gesture, revision);
      }
    });
    if (withheld) {
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (done) queueMicrotask(() => done());
      return true;
    }
    if (selected) return true;
    return forward();
  };
  stdout.write = interceptWrite;

  function paint(current: SelectionGesture): void {
    void current.frame.then((frame) => {
      if (!frame || disposed || suspended || gesture !== current || current.phase !== 'dragging')
        return;
      const previous = current.painted;
      if (previous?.focus.x === current.focus.x && previous.focus.y === current.focus.y) return;
      writeOriginal(renderSelection(frame, current.anchor, current.focus, previous));
      current.painted = { anchor: current.anchor, focus: current.focus };
    });
  }

  function copySelection(current: SelectionGesture): void {
    const focus = current.focus;
    copyQueue = copyQueue
      .then(async () => {
        const frame = await current.frame;
        if (!frame || disposed) return;
        const text = selectionText(frame, current.anchor, focus);
        if (!text) return;
        if ((await copy(text)) === 'unavailable' && !disposed) {
          reportError('Could not copy selected text.');
        }
      })
      .catch(() => {
        if (!disposed) reportError('Could not copy selected text.');
      });
  }

  function handleMouse(event: MouseEvent, dispatch: MouseListener): void {
    if (disposed || suspended) {
      dispatch(event);
      return;
    }
    if (event.type === 'wheel-up' || event.type === 'wheel-down') {
      clear();
      dispatch(event);
      return;
    }
    const point = {
      x: Math.max(0, Math.min(stdout.columns - 1, event.x - 1)),
      y: Math.max(0, Math.min(stdout.rows - 1, event.y - 1)),
    };
    if (event.type === 'press') {
      clear();
      if (event.button !== 0 || event.ctrl || event.meta || event.shift) {
        dispatch(event);
        return;
      }
      const frame = new Promise<TerminalFrame | undefined>((resolve) => {
        terminal.write('', () => resolve(disposed ? undefined : snapshotTerminalFrame(terminal)));
      });
      gesture = { phase: 'pressed', anchor: point, focus: point, frame };
      return;
    }
    const current = gesture;
    if (!current || current.phase === 'selected') {
      dispatch(event);
      return;
    }
    if (event.type === 'move' && event.button !== 0) {
      clear();
      dispatch(event);
      return;
    }
    current.focus = point;
    if (point.x !== current.anchor.x || point.y !== current.anchor.y) current.phase = 'dragging';
    if (event.type === 'move') {
      paint(current);
      return;
    }
    if (event.type === 'release') {
      if (current.phase === 'dragging') {
        current.phase = 'selected';
        copySelection(current);
        redraw();
        const revision = writeRevision;
        terminal.write('', () => reconcile(current, revision));
      } else {
        clear();
        dispatch({ ...event, type: 'press' });
      }
    }
  }

  return {
    handleMouse,
    filterInput: (text) => {
      if (!gesture || text.length === 0) return text;
      if (text.startsWith('\u0003') && gesture.phase !== 'pressed') {
        copySelection(gesture);
        let end = 1;
        while (text.charCodeAt(end) === 3) end++;
        const rest = text.slice(end);
        if (rest) clear();
        return rest;
      }
      // The stdin boundary supplies complete CSI-u keys, never partial escape prefixes.
      const encoded = text.startsWith('\u001b[')
        ? /^(\d+)(?::[\d:]*)?(?:;(\d+)(?::([123]))?)?(?:;[\d:]*)?u$/.exec(text.slice(2))
        : null;
      if (encoded?.[3] === '3') return text;
      const modifiers = Number(encoded?.[2] ?? '1') - 1;
      const shortcutModifiers = modifiers & ~(64 | 128);
      const copyKey = encoded?.[1] === '99' && (shortcutModifiers === 4 || shortcutModifiers === 8);
      if (copyKey && gesture.phase !== 'pressed') {
        copySelection(gesture);
        return '';
      }
      clear();
      return text === '\u001b' || (encoded?.[1] === '27' && modifiers === 0) ? '' : text;
    },
    clear,
    suspend,
    resume: () => {
      if (disposed || !suspended) return;
      suspended = false;
      const revision = ++lifecycleRevision;
      writeRevision++;
      terminal.write('', () => {
        if (disposed || suspended || revision !== lifecycleRevision) return;
        terminal.reset();
        terminal.resize(stdout.columns, stdout.rows);
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      gesture = undefined;
      flushOutput();
      stdout.off('resize', onResize);
      if (stdout.write === interceptWrite) stdout.write = originalWrite;
      terminal.dispose();
    },
  };
}
