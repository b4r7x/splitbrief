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

const BACKSPACE_BYTE = /([\b\x7f])/;

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
    paste?: boolean | undefined;
    handleMouse?: ((event: MouseEvent, dispatch: MouseListener) => void) | undefined;
    filterInput?: ((text: string) => string) | undefined;
    onPaste?: (() => void) | undefined;
  },
): FilteredStdin {
  const filtered = bridgeTty(new PassThrough(), stdin);
  const decoder = new StringDecoder('utf8');
  const mouseEnabled = opts?.mouse ?? true;
  const hoverEnabled = opts?.hover ?? false;
  const pasteEnabled = opts?.paste ?? true;
  let mouseListeners: MouseListener[] = [];
  let heldPrefix = EMPTY_BUFFER;
  let pasteActive = false;
  let pasteChunks: Buffer[] = [];
  let pastePendingCr = false;
  let active = false;
  let disabled = false;
  let heldPrefixTimer: ReturnType<typeof setTimeout> | null = null;

  const clearHeldPrefixTimer = () => {
    if (!heldPrefixTimer) return;
    clearTimeout(heldPrefixTimer);
    heldPrefixTimer = null;
  };

  const emitText = (text: string) => {
    if (text.length === 0) return;
    filtered.write(text, 'utf8');
    // Ink consumes stdin through its `readable` listener. Flush each wire
    // segment before a following paste event can be emitted; otherwise Node's
    // readable buffer joins bytes on both sides of a paste and loses their
    // insertion order at the editor boundary.
    filtered.emit('readable');
  };

  // Ink parses one read as one key unless an ESC starts the next one, so `\x7f\x7f` would reach a
  // text field as one unknown key and delete nothing. Each backspace byte is written as its own key.
  const writeKeyBytes = (bytes: Buffer) => {
    if (bytes.length === 0) return;
    const text = decoder.write(bytes);
    const keys = opts?.filterInput ? opts.filterInput(text) : text;
    for (const key of keys.split(BACKSPACE_BYTE)) emitText(key);
  };

  const resetPaste = () => {
    pasteChunks = [];
    pastePendingCr = false;
  };

  const appendPaste = (bytes: Buffer) => {
    const scan = sanitizePasteBytes(bytes, pastePendingCr);
    pastePendingCr = scan.pendingCr;
    if (scan.bytes.length > 0) pasteChunks.push(scan.bytes);
  };

  const appendPasteNewline = () => {
    pastePendingCr = false;
    pasteChunks.push(NEWLINE_BYTES);
  };

  const flushPaste = () => {
    const body = Buffer.concat(pasteChunks);
    resetPaste();
    const text = sanitizePasteBody(body.toString('utf8'));
    opts?.onPaste?.();
    // A focused text field consumes the paste before Ink can interpret a lone
    // newline or tab as a key. Other views retain their plain-text fallback.
    if (!filtered.emit('paste', text)) emitText(text);
  };

  const writeSegment = (bytes: Buffer) => {
    if (pasteActive) {
      appendPaste(bytes);
      return;
    }
    writeKeyBytes(bytes);
  };

  const dispatchMouse = (event: MouseEvent | undefined) => {
    if (!event) return;
    const dispatch: MouseListener = (next) => {
      for (const listener of mouseListeners) listener(next);
    };
    if (opts?.handleMouse) opts.handleMouse(event, dispatch);
    else dispatch(event);
  };

  const processBytes = (source: Buffer) => {
    let cursor = 0;
    let textStart = 0;

    while (cursor < source.length) {
      if (source.readUInt8(cursor) !== ESC_BYTE) {
        cursor++;
        continue;
      }

      if (cursor > textStart) writeSegment(source.subarray(textStart, cursor));

      const tail = source.subarray(cursor);
      const decision = readEscape(tail, pasteActive, mouseEnabled);
      switch (decision.kind) {
        case 'hold':
          heldPrefix = Buffer.from(tail);
          return;
        case 'paste-start':
          pasteActive = true;
          resetPaste();
          cursor += decision.length;
          break;
        case 'paste-end':
          pasteActive = false;
          flushPaste();
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
          appendPasteNewline();
          cursor += decision.length;
          break;
        case 'text':
          writeKeyBytes(source.subarray(cursor, cursor + decision.length));
          cursor += decision.length;
          break;
      }
      textStart = cursor;
    }

    if (textStart < source.length) writeSegment(source.subarray(textStart));
  };

  const flushHeldPrefix = () => {
    if (heldPrefix.length === 0) return;
    const held = heldPrefix;
    heldPrefix = EMPTY_BUFFER;
    if (pasteActive) return;
    writeKeyBytes(held);
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
    setTerminalInputModes('enable', {
      mouse: mouseEnabled,
      paste: pasteEnabled,
      hover: hoverEnabled,
    });
    stdin.on('data', dataHandler);
    stdin.resume();
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
        setTerminalInputModes('disable', { mouse: mouseEnabled, paste: pasteEnabled });
      }
      flushHeldPrefix();
      emitText(decoder.end());
      heldPrefix = EMPTY_BUFFER;
      pasteActive = false;
      resetPaste();
      filtered.end();
    },
  };
}
