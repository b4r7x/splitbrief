import { PassThrough } from 'node:stream';
import { setTerminalInputModes } from './control.js';

export interface MouseEvent {
  type: 'wheel-up' | 'wheel-down';
  x: number;
  y: number;
  button: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

type MouseListener = (event: MouseEvent) => void;

// biome-ignore-start lint/suspicious/noControlCharactersInRegex: matches ANSI escape (U+001B) in terminal input
const SGR_MOUSE_RE = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
const PARTIAL_SGR_MOUSE_RE = /^(?:\u001b|\u001b\[|\u001b\[<[\d;]*)$/;
const COMPLETE_SGR_MOUSE_RE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: matches ANSI escape (U+001B) in terminal input
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

// How long a held lone trailing ESC waits for a continuation chunk before it is flushed as a
// real Escape keypress. Short enough to stay below the consumer escape-debounce so the key
// still registers promptly, long enough to let a split paste marker body arrive first.
const LONE_ESC_FLUSH_MS = 4;

export function parseMouseEvents(chunk: string): { events: MouseEvent[]; clean: string } {
  const events: MouseEvent[] = [];
  const clean = chunk.replace(SGR_MOUSE_RE, (_match, rawBtn, rawX, rawY) => {
    const btn = parseInt(rawBtn, 10);
    const baseButton = btn & ~(4 | 8 | 16);

    if (baseButton !== 64 && baseButton !== 65) return '';

    const x = parseInt(rawX, 10);
    const y = parseInt(rawY, 10);
    const shift = (btn & 4) !== 0;
    const meta = (btn & 8) !== 0;
    const ctrl = (btn & 16) !== 0;

    events.push({
      type: baseButton === 64 ? 'wheel-up' : 'wheel-down',
      x,
      y,
      button: baseButton,
      shift,
      meta,
      ctrl,
    });
    return '';
  });

  return { events, clean };
}

function prefixLengthHeldBack(text: string): number {
  // Longest suffix of `text` that is a proper prefix of a paste marker, so a marker
  // split across chunks is withheld until the next chunk completes it. The markers
  // share `[20`, so checking against both prefixes covers start and end.
  const maxLen = Math.min(text.length, PASTE_START.length - 1);
  // Hold a lone trailing ESC (len 1) one chunk so a paste marker whose leading `\x1b`
  // arrives alone reassembles instead of leaking its `[200~`/`[201~` body into the stream
  // (and leaving pasteActive stuck). The held ESC is re-prepended to the next chunk: if that
  // chunk does not continue a marker the ESC flushes then, and disable() flushes it if no
  // chunk follows, so a real Escape keypress is delayed at most one input byte, never lost.
  const minLen = 1;
  for (let len = maxLen; len >= minLen; len--) {
    const suffix = text.slice(text.length - len);
    if (PASTE_START.startsWith(suffix) || PASTE_END.startsWith(suffix)) {
      return len;
    }
  }
  return 0;
}

export function stripPasteMarkers(
  text: string,
  pasteActive: boolean,
): { clean: string; pasteActive: boolean; partial: string } {
  let active = pasteActive;
  const segments: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const startAt = text.indexOf(PASTE_START, cursor);
    const endAt = text.indexOf(PASTE_END, cursor);
    const next = startAt === -1 ? endAt : endAt === -1 ? startAt : Math.min(startAt, endAt);
    if (next === -1) {
      segments.push(text.slice(cursor));
      break;
    }
    segments.push(text.slice(cursor, next));
    if (next === startAt) {
      active = true;
      cursor = next + PASTE_START.length;
    } else {
      active = false;
      cursor = next + PASTE_END.length;
    }
  }

  const clean = segments.join('');
  const held = prefixLengthHeldBack(clean);
  if (held === 0) {
    return { clean, pasteActive: active, partial: '' };
  }
  return {
    clean: clean.slice(0, clean.length - held),
    pasteActive: active,
    partial: clean.slice(clean.length - held),
  };
}

export interface FilteredStdin {
  stdin: NodeJS.ReadStream;
  onMouse: (listener: MouseListener) => () => void;
  isPasteActive: () => boolean;
  disable: () => void;
}

let activeFilteredStdin: FilteredStdin | undefined;

export function setActiveFilteredStdin(instance: FilteredStdin | undefined): void {
  activeFilteredStdin = instance;
}

export function getActiveFilteredStdin(): FilteredStdin | undefined {
  return activeFilteredStdin;
}

function bridgeTty(filtered: PassThrough, stdin: NodeJS.ReadStream): NodeJS.ReadStream {
  Object.defineProperty(filtered, 'isTTY', {
    configurable: true,
    enumerable: true,
    get: () => stdin.isTTY,
  });
  Object.defineProperty(filtered, 'isRaw', {
    configurable: true,
    enumerable: true,
    get: () => stdin.isRaw,
  });
  Object.assign(filtered, {
    setRawMode(mode: boolean): PassThrough {
      stdin.setRawMode(mode);
      return filtered;
    },
    ref(): PassThrough {
      stdin.ref();
      return filtered;
    },
    unref(): PassThrough {
      stdin.unref();
      return filtered;
    },
  });
  // Ink types require tty.ReadStream, while the filter must be a writable PassThrough.
  // The TTY members Ink uses are bridged above; the cast is the interop boundary.
  return filtered as unknown as NodeJS.ReadStream;
}

function splitMouseChunk(raw: string): { processable: string; partial: string } {
  const lastEsc = raw.lastIndexOf('\u001b');
  if (lastEsc < 0) {
    return { processable: raw, partial: '' };
  }

  const tail = raw.slice(lastEsc);
  // A lone trailing ESC passes through to the paste layer, which decides whether to hold it
  // (it may head a split paste marker) rather than the mouse layer second-guessing here. Only a
  // partial that has advanced past the bare ESC (\x1b[, \x1b[<…) can head a mouse report whose
  // body lands next chunk, so those — and only those — are withheld one chunk until completion.
  if (tail !== '\u001b' && PARTIAL_SGR_MOUSE_RE.test(tail) && !COMPLETE_SGR_MOUSE_RE.test(tail)) {
    return { processable: raw.slice(0, lastEsc), partial: tail };
  }

  return { processable: raw, partial: '' };
}

export function createFilteredStdin(stdin: NodeJS.ReadStream): FilteredStdin {
  const filtered = bridgeTty(new PassThrough(), stdin);
  let mouseListeners: MouseListener[] = [];
  let partial = '';
  let pastePartial = '';
  let pasteActive = false;
  let disabled = false;
  let loneEscTimer: ReturnType<typeof setTimeout> | null = null;

  const clearLoneEscTimer = () => {
    if (loneEscTimer) {
      clearTimeout(loneEscTimer);
      loneEscTimer = null;
    }
  };

  // A lone trailing ESC is held one chunk so a paste marker whose leading `\x1b` arrives
  // alone can reassemble. But a real Escape keypress can also arrive as a lone ESC with no
  // follow-up chunk, and holding it indefinitely would freeze the Escape key. So when an
  // ESC is the only held byte and no paste is open, flush it after a short delay; the next
  // chunk (which would complete a marker) cancels the timer before it fires.
  const scheduleLoneEscFlush = () => {
    clearLoneEscTimer();
    if (pasteActive || pastePartial !== '\x1b') return;
    loneEscTimer = setTimeout(() => {
      loneEscTimer = null;
      if (disabled || pastePartial !== '\x1b') return;
      pastePartial = '';
      filtered.write('\x1b', 'utf8');
    }, LONE_ESC_FLUSH_MS);
  };

  const dataHandler = (chunk: Buffer) => {
    clearLoneEscTimer();
    const raw = partial + chunk.toString('utf8');
    const next = splitMouseChunk(raw);
    partial = next.partial;

    const { events, clean } = parseMouseEvents(next.processable);
    for (const event of events) {
      for (const listener of mouseListeners) listener(event);
    }

    const paste = stripPasteMarkers(pastePartial + clean, pasteActive);
    pasteActive = paste.pasteActive;
    pastePartial = paste.partial;
    if (paste.clean.length > 0) {
      filtered.write(paste.clean, 'utf8');
    }
    scheduleLoneEscFlush();
  };

  setTerminalInputModes(true);
  stdin.on('data', dataHandler);

  return {
    stdin: filtered,
    onMouse: (listener: MouseListener) => {
      mouseListeners.push(listener);
      return () => {
        mouseListeners = mouseListeners.filter((candidate) => candidate !== listener);
      };
    },
    isPasteActive: () => pasteActive,
    disable: () => {
      if (disabled) return;
      disabled = true;
      clearLoneEscTimer();
      stdin.off('data', dataHandler);
      setTerminalInputModes(false);
      // Flush any withheld bytes (e.g. a lone trailing ESC held for one chunk) so a final
      // keypress with no follow-up chunk still reaches the consumer instead of being dropped.
      const leftover = partial + pastePartial;
      if (leftover.length > 0) filtered.write(leftover, 'utf8');
      partial = '';
      pastePartial = '';
      pasteActive = false;
      filtered.end();
    },
  };
}
