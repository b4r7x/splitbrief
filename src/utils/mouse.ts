import { PassThrough } from 'node:stream';

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
const PARTIAL_SGR_MOUSE_RE = /^\u001b\[<[\d;]*$/;
const COMPLETE_SGR_MOUSE_RE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: matches ANSI escape (U+001B) in terminal input
const ENABLE_MOUSE_TRACKING = '\u001b[?1000h';
const ENABLE_SGR_MODE = '\u001b[?1006h';
const DISABLE_MOUSE_TRACKING = '\u001b[?1000l';
const DISABLE_SGR_MODE = '\u001b[?1006l';

export function parseMouseEvents(chunk: string): { events: MouseEvent[]; clean: string } {
  const events: MouseEvent[] = [];
  const clean = chunk.replace(SGR_MOUSE_RE, (match, rawBtn, rawX, rawY) => {
    const btn = parseInt(rawBtn, 10);
    const baseButton = btn & ~(4 | 8 | 16);

    if (baseButton < 64) return match;

    if (baseButton !== 64 && baseButton !== 65) return '';

    const x = parseInt(rawX, 10);
    const y = parseInt(rawY, 10);
    const shift = (btn & 4) !== 0;
    const meta = (btn & 8) !== 0;
    const ctrl = (btn & 16) !== 0;

    events.push({
      type: baseButton === 64 ? 'wheel-up' : 'wheel-down',
      x, y,
      button: baseButton,
      shift, meta, ctrl,
    });
    return '';
  });

  return { events, clean };
}

export interface FilteredStdin {
  stdin: NodeJS.ReadStream;
  onMouse: (listener: MouseListener) => () => void;
  disable: () => void;
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
    setRawMode: (mode: boolean) => {
      stdin.setRawMode(mode);
      return filtered;
    },
    ref: () => {
      stdin.ref();
      return filtered;
    },
    unref: () => {
      stdin.unref();
      return filtered;
    },
  });
  return filtered as unknown as NodeJS.ReadStream;
}

function setMouseMode(enabled: boolean): void {
  process.stdout.write(enabled ? ENABLE_MOUSE_TRACKING : DISABLE_MOUSE_TRACKING);
  process.stdout.write(enabled ? ENABLE_SGR_MODE : DISABLE_SGR_MODE);
}

function splitMouseChunk(raw: string): { processable: string; partial: string } {
  const lastEsc = raw.lastIndexOf('\u001b');
  if (lastEsc < 0) {
    return { processable: raw, partial: '' };
  }

  const tail = raw.slice(lastEsc);
  if (PARTIAL_SGR_MOUSE_RE.test(tail) && !COMPLETE_SGR_MOUSE_RE.test(tail)) {
    return { processable: raw.slice(0, lastEsc), partial: tail };
  }

  return { processable: raw, partial: '' };
}

export function createFilteredStdin(stdin: NodeJS.ReadStream): FilteredStdin {
  const filtered = bridgeTty(new PassThrough(), stdin);
  let mouseListeners: MouseListener[] = [];
  let partial = '';
  let disabled = false;

  const dataHandler = (chunk: Buffer) => {
    const raw = partial + chunk.toString('utf8');
    const next = splitMouseChunk(raw);
    partial = next.partial;

    const { events, clean } = parseMouseEvents(next.processable);
    for (const event of events) {
      for (const listener of mouseListeners) listener(event);
    }
    if (clean.length > 0) {
      filtered.write(clean, 'utf8');
    }
  };

  setMouseMode(true);
  stdin.on('data', dataHandler);

  return {
    stdin: filtered,
    onMouse: (listener: MouseListener) => {
      mouseListeners.push(listener);
      return () => {
        mouseListeners = mouseListeners.filter((candidate) => candidate !== listener);
      };
    },
    disable: () => {
      if (disabled) return;
      disabled = true;
      stdin.off('data', dataHandler);
      setMouseMode(false);
      partial = '';
      filtered.end();
    },
  };
}
