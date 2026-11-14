import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { setTerminalInputModes } from '../control.js';
import type { FilteredStdin, HeldPrefix, MouseEvent, MouseListener, PasteState } from './types.js';
import {
  EMPTY_BUFFER,
  appendPaste,
  appendPasteNewline,
  discardPaste,
  endPaste,
  startPaste,
} from './paste.js';
import { ESC_BYTE, clearHeldPrefixTimer, readEscape, scheduleHeldPrefixFlush } from './escape.js';

const BACKSPACE_BYTE = /([\b\x7f])/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: a kitty CSI-u key begins with ESC.
const KITTY_BACKSPACE = /^\x1b\[127((?:;[\d:;]*)?u)$/;

interface FilteredStdinOptions {
  activate?: boolean | undefined;
  mouse?: boolean | undefined;
  hover?: boolean | undefined;
  paste?: boolean | undefined;
  handleMouse?: ((event: MouseEvent, dispatch: MouseListener) => void) | undefined;
  filterInput?: ((text: string) => string) | undefined;
  onPaste?: (() => void) | undefined;
}

interface FilterState {
  filtered: NodeJS.ReadStream;
  decoder: StringDecoder;
  options: FilteredStdinOptions | undefined;
  mouseEnabled: boolean;
  mouseListeners: MouseListener[];
  held: HeldPrefix;
  paste: PasteState;
  active: boolean;
  disabled: boolean;
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

function emitText(filtered: NodeJS.ReadStream, text: string): void {
  if (text.length === 0) return;
  filtered.write(text, 'utf8');
  // Ink consumes stdin through its `readable` listener. Flush each wire
  // segment before a following paste event can be emitted; otherwise Node's
  // readable buffer joins bytes on both sides of a paste and loses their
  // insertion order at the editor boundary.
  filtered.emit('readable');
}

// Ink parses one read as one key unless an ESC starts the next one, so `\x7f\x7f` would reach a
// text field as one unknown key and delete nothing. Each backspace byte is written as its own key.
// Ink names DEL and the kitty codepoint 127 `delete`, the name of the forward Delete key, so the
// Backspace key is written as BS and codepoint 8, which Ink names `backspace`.
function writeKeyBytes(state: FilterState, bytes: Buffer): void {
  if (bytes.length === 0) return;
  const text = state.decoder.write(bytes);
  const keys = state.options?.filterInput ? state.options.filterInput(text) : text;
  for (const key of keys.split(BACKSPACE_BYTE)) {
    emitText(state.filtered, key === '\x7f' ? '\b' : key.replace(KITTY_BACKSPACE, '\x1b[8$1'));
  }
}

function reportPaste(state: FilterState, text: string): void {
  state.options?.onPaste?.();
  // A focused text field consumes the paste before Ink can interpret a lone
  // newline or tab as a key. Other views retain their plain-text fallback.
  if (!state.filtered.emit('paste', text)) emitText(state.filtered, text);
}

function writeSegment(state: FilterState, bytes: Buffer): void {
  if (state.paste.active) {
    appendPaste(state.paste, bytes);
    return;
  }
  writeKeyBytes(state, bytes);
}

function dispatchMouse(state: FilterState, event: MouseEvent | undefined): void {
  if (!event) return;
  const dispatch: MouseListener = (next) => {
    for (const listener of state.mouseListeners) listener(next);
  };
  if (state.options?.handleMouse) state.options.handleMouse(event, dispatch);
  else dispatch(event);
}

function processBytes(state: FilterState, source: Buffer): void {
  let cursor = 0;
  let textStart = 0;

  while (cursor < source.length) {
    if (source.readUInt8(cursor) !== ESC_BYTE) {
      cursor++;
      continue;
    }

    if (cursor > textStart) writeSegment(state, source.subarray(textStart, cursor));

    const tail = source.subarray(cursor);
    const decision = readEscape(tail, state.paste.active, state.mouseEnabled);
    switch (decision.kind) {
      case 'hold':
        state.held.bytes = Buffer.from(tail);
        return;
      case 'paste-start':
        startPaste(state.paste);
        cursor += decision.length;
        break;
      case 'paste-end':
        reportPaste(state, endPaste(state.paste));
        cursor += decision.length;
        break;
      case 'mouse':
        dispatchMouse(state, decision.event);
        cursor += decision.length;
        break;
      case 'skip':
        cursor += decision.length;
        break;
      case 'paste-newline':
        appendPasteNewline(state.paste);
        cursor += decision.length;
        break;
      case 'text':
        writeKeyBytes(state, source.subarray(cursor, cursor + decision.length));
        cursor += decision.length;
        break;
    }
    textStart = cursor;
  }

  if (textStart < source.length) writeSegment(state, source.subarray(textStart));
}

function flushHeldPrefix(state: FilterState): void {
  if (state.held.bytes.length === 0) return;
  const held = state.held.bytes;
  state.held.bytes = EMPTY_BUFFER;
  if (state.paste.active) return;
  writeKeyBytes(state, held);
}

function readChunk(state: FilterState, chunk: Buffer): void {
  clearHeldPrefixTimer(state.held);
  const source = state.held.bytes.length > 0 ? Buffer.concat([state.held.bytes, chunk]) : chunk;
  state.held.bytes = EMPTY_BUFFER;
  processBytes(state, source);
  if (state.paste.active) return;
  scheduleHeldPrefixFlush(state.held, () => {
    if (!state.disabled) flushHeldPrefix(state);
  });
}

export function createFilteredStdin(
  stdin: NodeJS.ReadStream,
  opts?: FilteredStdinOptions,
): FilteredStdin {
  const mouseEnabled = opts?.mouse ?? true;
  const hoverEnabled = opts?.hover ?? false;
  const pasteEnabled = opts?.paste ?? true;
  const state: FilterState = {
    filtered: bridgeTty(new PassThrough(), stdin),
    decoder: new StringDecoder('utf8'),
    options: opts,
    mouseEnabled,
    mouseListeners: [],
    held: { bytes: EMPTY_BUFFER, timer: null },
    paste: { active: false, chunks: [], pendingCr: false },
    active: false,
    disabled: false,
  };
  const dataHandler = (chunk: Buffer) => readChunk(state, chunk);

  const activate = () => {
    if (state.active || state.disabled) return;
    state.active = true;
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
    stdin: state.filtered,
    activate,
    onMouse: (listener: MouseListener) => {
      state.mouseListeners.push(listener);
      return () => {
        state.mouseListeners = state.mouseListeners.filter((candidate) => candidate !== listener);
      };
    },
    isPasteActive: () => state.paste.active,
    disable: () => {
      if (state.disabled) return;
      state.disabled = true;
      clearHeldPrefixTimer(state.held);
      if (state.active) {
        state.active = false;
        stdin.off('data', dataHandler);
        setTerminalInputModes('disable', { mouse: mouseEnabled, paste: pasteEnabled });
      }
      flushHeldPrefix(state);
      emitText(state.filtered, state.decoder.end());
      state.held.bytes = EMPTY_BUFFER;
      discardPaste(state.paste);
      state.filtered.end();
    },
  };
}
