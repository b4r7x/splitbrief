import type { EscapeDecision } from './types.js';
import { PASTE_END_BYTES, PASTE_START_BYTES, isPasteMarkerPrefix } from './paste.js';
import { readSgrMouse, readX10Mouse } from './mouse.js';

export const ESC_BYTE = 0x1b;
const CSI = 0x5b;
const SS3 = 0x4f;
const CSI_U_FINAL = 0x75;

export const NEWLINE_BYTES = Buffer.from([0x0a]);
export const HELD_PREFIX_FLUSH_MS = 35;
export const BARE_ESCAPE_PREFIX_FLUSH_MS = 50;

function startsWithBytes(source: Buffer, expected: Buffer): boolean {
  return source.length >= expected.length && source.subarray(0, expected.length).equals(expected);
}

function isDigitByte(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

export function isBareEscapePrefix(source: Buffer): boolean {
  return source.length === 1 && source.readUInt8(0) === ESC_BYTE;
}

function readCsiSequenceLength(source: Buffer): number | 'incomplete' | undefined {
  if (source.length < 2 || source.readUInt8(0) !== ESC_BYTE || source.readUInt8(1) !== CSI) {
    return undefined;
  }
  for (let i = 2; i < source.length; i++) {
    const byte = source.readUInt8(i);
    if (byte >= 0x40 && byte <= 0x7e) return i + 1;
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
