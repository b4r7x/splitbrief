import { Readable } from 'node:stream';

export interface MouseEvent {
  type: 'wheel-up' | 'wheel-down' | 'click' | 'release';
  x: number;
  y: number;
  button: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

type MouseListener = (event: MouseEvent) => void;

const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

function parseMouseEvents(chunk: string): { events: MouseEvent[]; clean: string } {
  const events: MouseEvent[] = [];
  const clean = chunk.replace(SGR_MOUSE_RE, (_match, rawBtn, rawX, rawY, suffix) => {
    const btn = parseInt(rawBtn, 10);
    const x = parseInt(rawX, 10);
    const y = parseInt(rawY, 10);
    const isRelease = suffix === 'm';

    const shift = (btn & 4) !== 0;
    const meta = (btn & 8) !== 0;
    const ctrl = (btn & 16) !== 0;
    const baseBtn = btn & 3;

    if (btn >= 64) {
      events.push({
        type: btn === 64 ? 'wheel-up' : 'wheel-down',
        x, y,
        button: btn & ~(4 | 8 | 16),
        shift, meta, ctrl,
      });
    } else if (isRelease) {
      events.push({ type: 'release', x, y, button: baseBtn, shift, meta, ctrl });
    } else {
      events.push({ type: 'click', x, y, button: baseBtn, shift, meta, ctrl });
    }
    return '';
  });

  return { events, clean };
}

export class FilteredStdin extends Readable {
  private realStdin: NodeJS.ReadStream;
  private mouseListeners: MouseListener[] = [];
  private partial = '';
  private dataHandler: ((chunk: Buffer) => void) | null = null;

  constructor(stdin: NodeJS.ReadStream) {
    super();
    this.realStdin = stdin;
  }

  onMouse(listener: MouseListener): () => void {
    this.mouseListeners.push(listener);
    return () => {
      this.mouseListeners = this.mouseListeners.filter(l => l !== listener);
    };
  }

  enable(): void {
    // Enable SGR mouse tracking
    process.stdout.write('\x1b[?1000h'); // basic mouse tracking
    process.stdout.write('\x1b[?1006h'); // SGR extended mode

    this.dataHandler = (chunk: Buffer) => {
      const raw = this.partial + chunk.toString('utf8');
      this.partial = '';

      // Hold partial escape sequence at end
      const lastEsc = raw.lastIndexOf('\x1b');
      let processable = raw;
      if (lastEsc >= 0 && lastEsc > raw.length - 20) {
        const tail = raw.slice(lastEsc);
        if (!SGR_MOUSE_RE.test(tail) && tail.length < 20 && /^\x1b\[<[\d;]*$/.test(tail)) {
          processable = raw.slice(0, lastEsc);
          this.partial = tail;
        }
      }

      const { events, clean } = parseMouseEvents(processable);
      for (const ev of events) {
        for (const listener of this.mouseListeners) listener(ev);
      }
      if (clean.length > 0) {
        this.push(Buffer.from(clean, 'utf8'));
      }
    };

    this.realStdin.on('data', this.dataHandler);
  }

  disable(): void {
    if (this.dataHandler) {
      this.realStdin.off('data', this.dataHandler);
      this.dataHandler = null;
    }
    process.stdout.write('\x1b[?1006l');
    process.stdout.write('\x1b[?1000l');
    this.partial = '';
  }

  // Proxy TTY properties
  get isTTY(): boolean { return this.realStdin.isTTY; }
  get isRaw(): boolean { return this.realStdin.isRaw; }
  setRawMode(mode: boolean): this { this.realStdin.setRawMode(mode); return this; }
  ref(): this { this.realStdin.ref(); return this; }
  unref(): this { this.realStdin.unref(); return this; }

  override _read(): void {
    // Data is pushed via the data handler
  }
}

let activeStdin: FilteredStdin | null = null;

export function enableMouseTracking(stdin: NodeJS.ReadStream): FilteredStdin {
  const filtered = new FilteredStdin(stdin);
  filtered.enable();
  activeStdin = filtered;

  const cleanup = () => {
    filtered.disable();
    activeStdin = null;
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  return filtered;
}

export function disableMouseTracking(): void {
  if (activeStdin) {
    activeStdin.disable();
    activeStdin = null;
  }
}
