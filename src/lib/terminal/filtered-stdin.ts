import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
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

// How long a held paste-marker prefix (a lone trailing ESC or any longer `\x1b[2…` remainder)
// waits for a continuation chunk before it is flushed as the real keypress it heads. Short
// enough to stay below the consumer escape-debounce so the key still registers promptly, long
// enough to let a split paste marker body arrive first.
const HELD_PREFIX_FLUSH_MS = 4;

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escape (U+001B) sequences from a paste body
const PASTE_BODY_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001bO[@-~]|\u001b/g;

// Inside a bracketed paste the terminal forwards the raw body, so an embedded carriage return or
// stray escape byte must not survive: Ink would explode the body into synthetic keypresses and a
// lone `\r` between two escape sequences reaches the consumer as a bare Return, firing submit /
// approval mid-paste. Convert CR(LF) to LF, drop CSI/SS3 sequences, and drop any remaining bare
// ESC while keeping the following printable text. The held-back paste-marker tail is excluded
// before this runs, so dropping a bare ESC here never eats a split end-marker prefix.
function sanitizePasteBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(PASTE_BODY_ESCAPE_RE, '');
}

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
  const parts: { text: string; active: boolean }[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const startAt = text.indexOf(PASTE_START, cursor);
    const endAt = text.indexOf(PASTE_END, cursor);
    const next = startAt === -1 ? endAt : endAt === -1 ? startAt : Math.min(startAt, endAt);
    if (next === -1) {
      parts.push({ text: text.slice(cursor), active });
      break;
    }
    parts.push({ text: text.slice(cursor, next), active });
    if (next === startAt) {
      active = true;
      cursor = next + PASTE_START.length;
    } else {
      active = false;
      cursor = next + PASTE_END.length;
    }
  }

  // The held-back tail (a paste-marker prefix split across chunks) is always a suffix of the last
  // part. It must stay raw and unsanitized so a lone trailing ESC heading a split end-marker can
  // reassemble next chunk; sanitizing only the body keeps the marker bytes out of the stream.
  const rawClean = parts.map((part) => part.text).join('');
  const held = prefixLengthHeldBack(rawClean);
  const partial = held === 0 ? '' : rawClean.slice(rawClean.length - held);

  const bodyLengths: number[] = [];
  let remainingTail = held;
  for (let i = parts.length - 1; i >= 0; i--) {
    const trim = Math.min(remainingTail, parts[i]?.text.length ?? 0);
    bodyLengths[i] = (parts[i]?.text.length ?? 0) - trim;
    remainingTail -= trim;
  }

  const clean = parts
    .map((part, i) => {
      const body = part.text.slice(0, bodyLengths[i]);
      return part.active ? sanitizePasteBody(body) : body;
    })
    .join('');

  return { clean, pasteActive: active, partial };
}

export interface FilteredStdin {
  stdin: NodeJS.ReadStream;
  activate: () => void;
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

export function createFilteredStdin(
  stdin: NodeJS.ReadStream,
  opts?: { activate?: boolean | undefined },
): FilteredStdin {
  const filtered = bridgeTty(new PassThrough(), stdin);
  const decoder = new StringDecoder('utf8');
  let mouseListeners: MouseListener[] = [];
  let partial = '';
  let pastePartial = '';
  let pasteActive = false;
  let active = false;
  let disabled = false;
  let heldPrefixTimer: ReturnType<typeof setTimeout> | null = null;

  const clearHeldPrefixTimer = () => {
    if (heldPrefixTimer) {
      clearTimeout(heldPrefixTimer);
      heldPrefixTimer = null;
    }
  };

  // A paste-marker prefix (`\x1b`, `\x1b[2`, `\x1b[20`, `\x1b[200`, `\x1b[201`) is held one
  // chunk so a marker split across chunks can reassemble. But that same prefix can also be the
  // start of a real keypress with no follow-up chunk; holding it indefinitely would freeze that
  // key and then merge its bytes into the next chunk, re-parsing as a different key. So when a
  // prefix is held and no paste is open, flush it as its own chunk after a short delay; the next
  // chunk (which would complete a marker) cancels the timer before it fires.
  const scheduleHeldPrefixFlush = () => {
    clearHeldPrefixTimer();
    if (pasteActive || pastePartial === '') return;
    const held = pastePartial;
    heldPrefixTimer = setTimeout(() => {
      heldPrefixTimer = null;
      if (disabled || pastePartial !== held) return;
      pastePartial = '';
      filtered.write(held, 'utf8');
    }, HELD_PREFIX_FLUSH_MS);
  };

  const dataHandler = (chunk: Buffer) => {
    clearHeldPrefixTimer();
    const raw = partial + decoder.write(chunk);
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
    scheduleHeldPrefixFlush();
  };

  const activate = () => {
    if (active || disabled) return;
    active = true;
    setTerminalInputModes('enable');
    stdin.on('data', dataHandler);
  };

  if (opts?.activate !== false) activate();

  return {
    stdin: filtered,
    activate,
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
      clearHeldPrefixTimer();
      if (active) {
        active = false;
        stdin.off('data', dataHandler);
        setTerminalInputModes('disable');
      }
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
