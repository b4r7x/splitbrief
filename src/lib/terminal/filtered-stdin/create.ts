import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { setTerminalInputModes, terminalSequences, writeTerminalSequence } from '../control.js';
import { drain, emitText } from './deliver.js';
import type {
  FilterState,
  FilteredStdin,
  FilteredStdinOptions,
  MouseAction,
  MouseEvent,
  MouseListener,
} from './types.js';
import {
  EMPTY_BUFFER,
  appendPaste,
  appendPasteNewline,
  discardPaste,
  endPaste,
  startPaste,
} from './paste.js';
import { ESC_BYTE, clearHeldPrefixTimer, readEscape, scheduleHeldPrefixFlush } from './escape.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: an Alt+Backspace key begins with ESC.
const BACKSPACE_KEY = /(\x1b?[\b\x7f])/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: an Alt+Backspace key begins with ESC.
const DEL_KEY = /^(\x1b?)\x7f$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: a kitty CSI-u key begins with ESC.
const KITTY_BACKSPACE = /^\x1b\[127((?:;[\d:;]*)?u)$/;
// A read of fewer than 64 characters is typed keys. A longer read is a paste that the terminal
// did not bracket, and its line breaks stay text.
const TYPED_READ_LIMIT = 64;
// biome-ignore lint/suspicious/noControlCharactersInRegex: an Alt+Enter key begins with ESC.
const ENTER_KEY = /(\x1b?\r)\n?/;

function isTypedRead(bytes: Buffer): boolean {
  return bytes.toString('utf8').length < TYPED_READ_LIMIT;
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

// Ink parses one read as one key unless an ESC starts the next one, so `\x7f\x7f` would reach a
// text field as one unknown key and delete nothing. Each backspace byte is written as its own key.
// Ink names DEL and the kitty codepoint 127 `delete`, the name of the forward Delete key, so the
// Backspace key is written as BS and codepoint 8, which Ink names `backspace`. Ink names Enter only
// when it stands alone, so each Enter of a typed read is written as its own key, and CR LF is one
// Enter. On a terminal that does not bracket a paste, a pasted line break and a typed Enter are the
// same bytes, so the Enter of a typed read waits for the terminal's word that it brackets a paste.
function writeKeyBytes(state: FilterState, bytes: Buffer, typed: boolean): void {
  if (bytes.length === 0) return;
  const text = state.decoder.write(bytes);
  const keys = state.options?.filterInput ? state.options.filterInput(text) : text;
  for (const piece of keys.split(BACKSPACE_KEY)) {
    for (const key of typed && state.bracketsPaste ? piece.split(ENTER_KEY) : [piece]) {
      if (key.length === 0) continue;
      const named = key.replace(DEL_KEY, '$1\b').replace(KITTY_BACKSPACE, '\x1b[8$1');
      state.queue.push({ kind: 'key', text: named });
    }
  }
}

function writeSegment(state: FilterState, bytes: Buffer, typed: boolean): void {
  if (state.paste.active) {
    appendPaste(state.paste, bytes);
    return;
  }
  writeKeyBytes(state, bytes, typed);
}

// A click acts on what the frame on screen shows, so the listeners read it now. What they do
// waits for its turn behind the input read before it.
function readMouse(state: FilterState, event: MouseEvent | undefined): void {
  if (!event) return;
  const actions: MouseAction[] = [];
  const dispatch = (next: MouseEvent) => {
    for (const listener of state.mouseListeners) {
      const action = listener(next);
      if (action !== undefined) actions.push(action);
    }
  };
  if (state.options?.handleMouse) state.options.handleMouse(event, dispatch);
  else dispatch(event);
  if (actions.length === 0) return;
  const wheel = event.type === 'wheel-up' || event.type === 'wheel-down';
  state.queue.push({ kind: wheel ? 'wheel' : 'mouse', actions });
}

function isCarriedEscape(source: Buffer, textStart: number, cursor: number): boolean {
  return cursor - textStart === 1 && source.readUInt8(textStart) === ESC_BYTE;
}

function processBytes(state: FilterState, source: Buffer, typed: boolean): void {
  let cursor = 0;
  let textStart = 0;

  while (cursor < source.length) {
    if (source.readUInt8(cursor) !== ESC_BYTE) {
      cursor++;
      continue;
    }

    const tail = source.subarray(cursor);
    const decision = readEscape(tail, state.paste.active, state.mouseEnabled);
    // Ink joins a lone ESC with the key after it in the same read (Alt and that key), so the two
    // stay one key.
    const altKey = decision.kind === 'text' && isCarriedEscape(source, textStart, cursor);
    if (cursor > textStart && !altKey)
      writeSegment(state, source.subarray(textStart, cursor), typed);

    switch (decision.kind) {
      case 'hold':
        state.held.bytes = Buffer.from(tail);
        return;
      case 'paste-start':
        state.bracketsPaste = true;
        startPaste(state.paste);
        cursor += decision.length;
        break;
      case 'paste-end':
        state.queue.push({ kind: 'paste', text: endPaste(state.paste) });
        cursor += decision.length;
        break;
      case 'mouse':
        readMouse(state, decision.event);
        cursor += decision.length;
        break;
      case 'skip':
        cursor += decision.length;
        break;
      case 'paste-newline':
        appendPasteNewline(state.paste);
        cursor += decision.length;
        break;
      case 'paste-mode':
        state.bracketsPaste = decision.brackets;
        cursor += decision.length;
        break;
      case 'text':
        if (decision.length === 1) {
          if (!altKey) textStart = cursor;
          cursor += 1;
          continue;
        }
        writeKeyBytes(
          state,
          source.subarray(altKey ? textStart : cursor, cursor + decision.length),
          typed,
        );
        cursor += decision.length;
        break;
    }
    textStart = cursor;
  }

  if (textStart < source.length) writeSegment(state, source.subarray(textStart), typed);
}

function flushHeldPrefix(state: FilterState): void {
  if (state.held.bytes.length === 0) return;
  const held = state.held.bytes;
  state.held.bytes = EMPTY_BUFFER;
  if (state.paste.active) return;
  writeKeyBytes(state, held, isTypedRead(held));
  drain(state);
}

function readChunk(state: FilterState, chunk: Buffer): void {
  clearHeldPrefixTimer(state.held);
  const source = state.held.bytes.length > 0 ? Buffer.concat([state.held.bytes, chunk]) : chunk;
  state.held.bytes = EMPTY_BUFFER;
  // A click is read against the frame on screen, so the whole read is parsed before its first
  // input reaches the app.
  processBytes(state, source, isTypedRead(source));
  drain(state);
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
  const state: FilterState = {
    filtered: bridgeTty(new PassThrough(), stdin),
    decoder: new StringDecoder('utf8'),
    options: opts,
    mouseEnabled,
    mouseListeners: [],
    held: { bytes: EMPTY_BUFFER, timer: null },
    paste: { active: false, chunks: [], pendingCr: false },
    bracketsPaste: false,
    active: false,
    disabled: false,
    queue: [],
    hold: null,
    waiting: false,
    delivering: false,
  };
  const dataHandler = (chunk: Buffer) => readChunk(state, chunk);

  const activate = () => {
    if (state.active || state.disabled) return;
    state.active = true;
    setTerminalInputModes('enable', { mouse: mouseEnabled, hover: hoverEnabled });
    // The reply tells about the mode that SPLITBRIEF set. Terminal.app is not asked, because it may
    // show the query as text.
    if (process.env['TERM_PROGRAM'] !== 'Apple_Terminal') {
      writeTerminalSequence(terminalSequences.queryBracketedPaste);
    }
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
    // A key that waited behind others was read before the paste that is open now.
    isPasteActive: () => state.paste.active && !state.delivering,
    holdInput: (hold) => {
      state.hold = hold;
      return () => {
        state.hold = null;
        state.waiting = false;
        drain(state);
      };
    },
    disable: () => {
      if (state.disabled) return;
      state.disabled = true;
      state.hold = null;
      state.waiting = false;
      clearHeldPrefixTimer(state.held);
      if (state.active) {
        state.active = false;
        stdin.off('data', dataHandler);
        setTerminalInputModes('disable', { mouse: mouseEnabled });
      }
      drain(state);
      flushHeldPrefix(state);
      emitText(state.filtered, state.decoder.end());
      state.held.bytes = EMPTY_BUFFER;
      discardPaste(state.paste);
      state.filtered.end();
    },
  };
}
