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

const ESC = 0x1b;
const CSI = 0x5b;
const SS3 = 0x4f;
const SGR_PREFIX = Buffer.from('\u001b[<', 'ascii');
const X10_PREFIX = Buffer.from('\u001b[M', 'ascii');
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';
const PASTE_START_BYTES = Buffer.from(PASTE_START, 'ascii');
const PASTE_END_BYTES = Buffer.from(PASTE_END, 'ascii');
const EMPTY_BUFFER = Buffer.alloc(0);

const HELD_PREFIX_FLUSH_MS = 35;
const BARE_ESCAPE_PREFIX_FLUSH_MS = 50;

// biome-ignore-start lint/suspicious/noControlCharactersInRegex: matches ANSI escape bytes in terminal input
const SGR_MOUSE_RE = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
const X10_MOUSE_RE = /\u001b\[M([\s\S])([\s\S])([\s\S])/g;
const PASTE_BODY_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001bO[@-~]|\u001b/g;
const PASTE_BODY_UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: matches ANSI escape bytes in terminal input

function sanitizePasteBody(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(PASTE_BODY_ESCAPE_RE, '')
    .replace(PASTE_BODY_UNSAFE_CONTROL_RE, '');
}

function sanitizePasteBytes(body: Buffer): Buffer {
  const clean: number[] = [];
  let i = 0;
  while (i < body.length) {
    const byte = body.readUInt8(i);
    if (byte === 0x0d) {
      if (i + 1 < body.length && body.readUInt8(i + 1) === 0x0a) i++;
      clean.push(0x0a);
    } else if (byte === 0x09 || byte === 0x0a || (byte >= 0x20 && byte !== 0x7f)) {
      clean.push(byte);
    }
    i++;
  }
  return Buffer.from(clean);
}

function createMouseEvent(btn: number, x: number, y: number): MouseEvent | undefined {
  const baseButton = btn & ~(4 | 8 | 16);
  if (baseButton !== 64 && baseButton !== 65) return undefined;

  return {
    type: baseButton === 64 ? 'wheel-up' : 'wheel-down',
    x,
    y,
    button: baseButton,
    shift: (btn & 4) !== 0,
    meta: (btn & 8) !== 0,
    ctrl: (btn & 16) !== 0,
  };
}

export function parseMouseEvents(chunk: string): { events: MouseEvent[]; clean: string } {
  const events: MouseEvent[] = [];
  const pushMouseEvent = (btn: number, x: number, y: number) => {
    const event = createMouseEvent(btn, x, y);
    if (event) events.push(event);
  };

  const clean = chunk
    .replace(SGR_MOUSE_RE, (_match, rawBtn, rawX, rawY) => {
      pushMouseEvent(parseInt(rawBtn, 10), parseInt(rawX, 10), parseInt(rawY, 10));
      return '';
    })
    .replace(X10_MOUSE_RE, (_match, rawBtn, rawX, rawY) => {
      pushMouseEvent(rawBtn.charCodeAt(0) - 32, rawX.charCodeAt(0) - 32, rawY.charCodeAt(0) - 32);
      return '';
    });

  return { events, clean };
}

function startsWithBytes(source: Buffer, expected: Buffer): boolean {
  return source.length >= expected.length && source.subarray(0, expected.length).equals(expected);
}

function isPrefixOfBytes(source: Buffer, expected: Buffer): boolean {
  return source.length < expected.length && expected.subarray(0, source.length).equals(source);
}

function isPasteMarkerPrefix(source: Buffer): boolean {
  return isPrefixOfBytes(source, PASTE_START_BYTES) || isPrefixOfBytes(source, PASTE_END_BYTES);
}

function isDigitByte(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function isBareEscapePrefix(source: Buffer): boolean {
  return source.length === 1 && source.readUInt8(0) === ESC;
}

type MouseRead =
  | { kind: 'complete'; length: number; event: MouseEvent | undefined }
  | { kind: 'incomplete' };

function readX10Mouse(source: Buffer): MouseRead | undefined {
  if (!startsWithBytes(source, X10_PREFIX)) return undefined;
  if (source.length < 6) return { kind: 'incomplete' };
  return {
    kind: 'complete',
    length: 6,
    event: createMouseEvent(
      source.readUInt8(3) - 32,
      source.readUInt8(4) - 32,
      source.readUInt8(5) - 32,
    ),
  };
}

function readSgrMouse(source: Buffer): MouseRead | undefined {
  if (!startsWithBytes(source, SGR_PREFIX)) return undefined;

  for (let i = SGR_PREFIX.length; i < source.length; i++) {
    const byte = source.readUInt8(i);
    if (byte === 0x4d || byte === 0x6d) {
      const params = source.subarray(SGR_PREFIX.length, i).toString('ascii').split(';');
      if (params.length !== 3 || params.some((param) => !/^\d+$/.test(param))) {
        return undefined;
      }
      const [rawBtn, rawX, rawY] = params;
      if (rawBtn === undefined || rawX === undefined || rawY === undefined) return undefined;
      return {
        kind: 'complete',
        length: i + 1,
        event: createMouseEvent(parseInt(rawBtn, 10), parseInt(rawX, 10), parseInt(rawY, 10)),
      };
    }
    if (!isDigitByte(byte) && byte !== 0x3b) return undefined;
  }

  return { kind: 'incomplete' };
}

function readCsiSequenceLength(source: Buffer): number | 'incomplete' | undefined {
  if (source.length < 2 || source.readUInt8(0) !== ESC || source.readUInt8(1) !== CSI) {
    return undefined;
  }
  for (let i = 2; i < source.length; i++) {
    const byte = source.readUInt8(i);
    if (byte >= 0x40 && byte <= 0x7e) return i + 1;
  }
  return 'incomplete';
}

function readSs3SequenceLength(source: Buffer): number | 'incomplete' | undefined {
  if (source.length < 2 || source.readUInt8(0) !== ESC || source.readUInt8(1) !== SS3) {
    return undefined;
  }
  return source.length < 3 ? 'incomplete' : 3;
}

type EscapeDecision =
  | { kind: 'hold' }
  | { kind: 'paste-start'; length: number }
  | { kind: 'paste-end'; length: number }
  | { kind: 'mouse'; length: number; event: MouseEvent | undefined }
  | { kind: 'skip'; length: number }
  | { kind: 'text'; length: number };

function readPasteEscape(source: Buffer): EscapeDecision {
  const csiLength = readCsiSequenceLength(source);
  if (csiLength === 'incomplete') return { kind: 'hold' };
  if (typeof csiLength === 'number') return { kind: 'skip', length: csiLength };

  const ss3Length = readSs3SequenceLength(source);
  if (ss3Length === 'incomplete') return { kind: 'hold' };
  if (typeof ss3Length === 'number') return { kind: 'skip', length: ss3Length };

  return { kind: 'skip', length: 1 };
}

function readEscape(source: Buffer, pasteActive: boolean, mouseEnabled: boolean): EscapeDecision {
  if (startsWithBytes(source, PASTE_START_BYTES)) {
    return { kind: 'paste-start', length: PASTE_START_BYTES.length };
  }
  if (startsWithBytes(source, PASTE_END_BYTES)) {
    return { kind: 'paste-end', length: PASTE_END_BYTES.length };
  }
  if (isPasteMarkerPrefix(source)) return { kind: 'hold' };
  if (pasteActive) return readPasteEscape(source);

  if (mouseEnabled) {
    const x10 = readX10Mouse(source);
    if (x10?.kind === 'incomplete') return { kind: 'hold' };
    if (x10?.kind === 'complete') {
      return { kind: 'mouse', length: x10.length, event: x10.event };
    }

    const sgr = readSgrMouse(source);
    if (sgr?.kind === 'incomplete') return { kind: 'hold' };
    if (sgr?.kind === 'complete') {
      return { kind: 'mouse', length: sgr.length, event: sgr.event };
    }
  }

  return { kind: 'text', length: 1 };
}

function prefixLengthHeldBack(text: string): number {
  const maxLen = Math.min(text.length, PASTE_START.length - 1);
  for (let len = maxLen; len >= 1; len--) {
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

  const rawClean = parts.map((part) => part.text).join('');
  const held = prefixLengthHeldBack(rawClean);
  const partial = held === 0 ? '' : rawClean.slice(rawClean.length - held);

  const bodyLengths: number[] = [];
  let remainingTail = held;
  for (let i = parts.length - 1; i >= 0; i--) {
    const partLength = parts[i]?.text.length ?? 0;
    const trim = Math.min(remainingTail, partLength);
    bodyLengths[i] = partLength - trim;
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
  return filtered as unknown as NodeJS.ReadStream;
}

export function createFilteredStdin(
  stdin: NodeJS.ReadStream,
  opts?: { activate?: boolean | undefined; mouse?: boolean | undefined },
): FilteredStdin {
  const filtered = bridgeTty(new PassThrough(), stdin);
  const decoder = new StringDecoder('utf8');
  const mouseEnabled = opts?.mouse ?? true;
  let mouseListeners: MouseListener[] = [];
  let heldPrefix = EMPTY_BUFFER;
  let pasteActive = false;
  let active = false;
  let disabled = false;
  let heldPrefixTimer: ReturnType<typeof setTimeout> | null = null;

  const clearHeldPrefixTimer = () => {
    if (!heldPrefixTimer) return;
    clearTimeout(heldPrefixTimer);
    heldPrefixTimer = null;
  };

  const writeText = (text: string, paste: boolean) => {
    const output = paste ? sanitizePasteBody(text) : text;
    if (output.length > 0) filtered.write(output, 'utf8');
  };

  const writeBytes = (bytes: Buffer, paste: boolean) => {
    const clean = paste ? sanitizePasteBytes(bytes) : bytes;
    if (clean.length === 0) return;
    writeText(decoder.write(clean), paste);
  };

  const dispatchMouse = (event: MouseEvent | undefined) => {
    if (!event) return;
    for (const listener of mouseListeners) listener(event);
  };

  const processBytes = (source: Buffer) => {
    let cursor = 0;
    let textStart = 0;

    while (cursor < source.length) {
      if (source.readUInt8(cursor) !== ESC) {
        cursor++;
        continue;
      }

      if (cursor > textStart) writeBytes(source.subarray(textStart, cursor), pasteActive);

      const tail = source.subarray(cursor);
      const decision = readEscape(tail, pasteActive, mouseEnabled);
      switch (decision.kind) {
        case 'hold':
          heldPrefix = Buffer.from(tail);
          return;
        case 'paste-start':
          pasteActive = true;
          cursor += decision.length;
          break;
        case 'paste-end':
          pasteActive = false;
          cursor += decision.length;
          break;
        case 'mouse':
          dispatchMouse(decision.event);
          cursor += decision.length;
          break;
        case 'skip':
          cursor += decision.length;
          break;
        case 'text':
          writeBytes(source.subarray(cursor, cursor + decision.length), false);
          cursor += decision.length;
          break;
      }
      textStart = cursor;
    }

    if (textStart < source.length) writeBytes(source.subarray(textStart), pasteActive);
  };

  const flushHeldPrefix = () => {
    if (heldPrefix.length === 0) return;
    const held = heldPrefix;
    heldPrefix = EMPTY_BUFFER;
    if (pasteActive) return;
    writeBytes(held, false);
  };

  const scheduleHeldPrefixFlush = () => {
    clearHeldPrefixTimer();
    if (heldPrefix.length === 0) return;
    if (pasteActive) return;
    const held = heldPrefix;
    heldPrefixTimer = setTimeout(
      () => {
        heldPrefixTimer = null;
        if (disabled || !heldPrefix.equals(held)) return;
        flushHeldPrefix();
      },
      isBareEscapePrefix(held) ? BARE_ESCAPE_PREFIX_FLUSH_MS : HELD_PREFIX_FLUSH_MS,
    );
  };

  const dataHandler = (chunk: Buffer) => {
    clearHeldPrefixTimer();
    const source = heldPrefix.length > 0 ? Buffer.concat([heldPrefix, chunk]) : chunk;
    heldPrefix = EMPTY_BUFFER;
    processBytes(source);
    scheduleHeldPrefixFlush();
  };

  const activate = () => {
    if (active || disabled) return;
    active = true;
    setTerminalInputModes('enable', { mouse: mouseEnabled, paste: true });
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
        setTerminalInputModes('disable', { mouse: mouseEnabled, paste: true });
      }
      flushHeldPrefix();
      writeText(decoder.end(), pasteActive);
      heldPrefix = EMPTY_BUFFER;
      pasteActive = false;
      filtered.end();
    },
  };
}
