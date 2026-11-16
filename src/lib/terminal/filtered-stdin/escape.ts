import type { EscapeDecision, HeldPrefix } from './types.js';
import { PASTE_END_BYTES, PASTE_START_BYTES, isPasteMarkerPrefix } from './paste.js';
import { readSgrMouse, readX10Mouse } from './mouse.js';

export const ESC_BYTE = 0x1b;
const CSI = 0x5b;
const SS3 = 0x4f;
const CSI_U_FINAL = 0x75;

// A DECRPM reply after its CSI: `? mode ; state $ y`. State 1 is set and 3 is permanently set.
const MODE_REPORT = /^\?(\d+);(\d)\$y$/;
const BRACKETED_PASTE_MODE = '2004';

const HELD_PREFIX_FLUSH_MS = 35;
const BARE_ESCAPE_PREFIX_FLUSH_MS = 50;

function startsWithBytes(source: Buffer, expected: Buffer): boolean {
  return source.length >= expected.length && source.subarray(0, expected.length).equals(expected);
}

function isDigitByte(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function isBareEscapePrefix(source: Buffer): boolean {
  return source.length === 1 && source.readUInt8(0) === ESC_BYTE;
}

export function clearHeldPrefixTimer(held: HeldPrefix): void {
  if (!held.timer) return;
  clearTimeout(held.timer);
  held.timer = null;
}

export function scheduleHeldPrefixFlush(held: HeldPrefix, flush: () => void): void {
  clearHeldPrefixTimer(held);
  if (held.bytes.length === 0) return;
  const bytes = held.bytes;
  held.timer = setTimeout(
    () => {
      held.timer = null;
      if (held.bytes.equals(bytes)) flush();
    },
    isBareEscapePrefix(bytes) ? BARE_ESCAPE_PREFIX_FLUSH_MS : HELD_PREFIX_FLUSH_MS,
  );
}

function readCsiSequenceLength(source: Buffer): number | 'incomplete' | undefined {
  if (source.length < 2 || source.readUInt8(0) !== ESC_BYTE || source.readUInt8(1) !== CSI) {
    return undefined;
  }
  for (let i = 2; i < source.length; i++) {
    const byte = source.readUInt8(i);
    if (byte >= 0x40 && byte <= 0x7e) return i + 1;
    if (byte < 0x20 || byte > 0x3f) return undefined;
  }
  return 'incomplete';
}

function isCsiULineBreak(source: Buffer, csiLength: number): boolean {
  if (source.readUInt8(csiLength - 1) !== CSI_U_FINAL) return false;
  let code = 0;
  let hasDigit = false;
  for (let i = 2; i < csiLength - 1; i++) {
    const byte = source.readUInt8(i);
    if (byte === 0x3b) break;
    if (!isDigitByte(byte)) return false;
    code = code * 10 + (byte - 0x30);
    hasDigit = true;
  }
  return hasDigit && (code === 13 || code === 10);
}

function readSs3SequenceLength(source: Buffer): number | 'incomplete' | undefined {
  if (source.length < 2 || source.readUInt8(0) !== ESC_BYTE || source.readUInt8(1) !== SS3) {
    return undefined;
  }
  return source.length < 3 ? 'incomplete' : 3;
}

function readPasteEscape(source: Buffer): EscapeDecision {
  const csiLength = readCsiSequenceLength(source);
  if (csiLength === 'incomplete') return { kind: 'hold' };
  if (typeof csiLength === 'number') {
    if (isCsiULineBreak(source, csiLength)) return { kind: 'paste-newline', length: csiLength };
    return { kind: 'skip', length: csiLength };
  }

  const ss3Length = readSs3SequenceLength(source);
  if (ss3Length === 'incomplete') return { kind: 'hold' };
  if (typeof ss3Length === 'number') return { kind: 'skip', length: ss3Length };

  return { kind: 'skip', length: 1 };
}

export function readEscape(
  source: Buffer,
  pasteActive: boolean,
  mouseEnabled: boolean,
): EscapeDecision {
  if (startsWithBytes(source, PASTE_START_BYTES)) {
    return { kind: 'paste-start', length: PASTE_START_BYTES.length };
  }
  if (startsWithBytes(source, PASTE_END_BYTES)) {
    return { kind: 'paste-end', length: PASTE_END_BYTES.length };
  }
  if (isPasteMarkerPrefix(source)) return { kind: 'hold' };
  if (pasteActive) return readPasteEscape(source);

  if (source.length >= 2 && source.readUInt8(1) === 0x5d) {
    for (let i = 2; i < source.length; i++) {
      if (source.readUInt8(i) === 0x07) return { kind: 'skip', length: i + 1 };
      if (
        source.readUInt8(i) === ESC_BYTE &&
        i + 1 < source.length &&
        source.readUInt8(i + 1) === 0x5c
      ) {
        return { kind: 'skip', length: i + 2 };
      }
    }
    return { kind: 'hold' };
  }
  const csiLength = readCsiSequenceLength(source);
  if (
    typeof csiLength === 'number' &&
    source.readUInt8(2) === 0x3f &&
    source.readUInt8(csiLength - 1) === 0x63
  ) {
    return { kind: 'skip', length: csiLength };
  }
  if (typeof csiLength === 'number') {
    const report = MODE_REPORT.exec(source.toString('latin1', 2, csiLength));
    if (report !== null) {
      if (report[1] !== BRACKETED_PASTE_MODE) return { kind: 'skip', length: csiLength };
      const brackets = report[2] === '1' || report[2] === '3';
      return { kind: 'paste-mode', length: csiLength, brackets };
    }
  }

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

  const keyLength = csiLength ?? readSs3SequenceLength(source);
  if (keyLength === 'incomplete') return { kind: 'hold' };
  if (typeof keyLength === 'number') return { kind: 'text', length: keyLength };

  return { kind: 'text', length: 1 };
}
