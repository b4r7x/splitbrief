import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { setTerminalInputModes } from '../control.js';
import type { FilteredStdin, MouseEvent, MouseListener } from './types.js';
import { EMPTY_BUFFER, sanitizePasteBody, sanitizePasteBytes } from './paste.js';
import {
  BARE_ESCAPE_PREFIX_FLUSH_MS,
  ESC_BYTE,
  HELD_PREFIX_FLUSH_MS,
  NEWLINE_BYTES,
  isBareEscapePrefix,
  readEscape,
} from './escape.js';

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
  opts?: {
    activate?: boolean | undefined;
    mouse?: boolean | undefined;
    hover?: boolean | undefined;
  },
): FilteredStdin {
  const filtered = bridgeTty(new PassThrough(), stdin);
  const decoder = new StringDecoder('utf8');
  const mouseEnabled = opts?.mouse ?? true;
  const hoverEnabled = opts?.hover ?? false;
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
      if (source.readUInt8(cursor) !== ESC_BYTE) {
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
        case 'paste-newline':
          writeBytes(NEWLINE_BYTES, true);
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
    setTerminalInputModes('enable', { mouse: mouseEnabled, paste: true, hover: hoverEnabled });
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
