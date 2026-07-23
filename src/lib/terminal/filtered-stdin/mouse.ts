import type { MouseEvent, MouseEventType } from './types.js';

const MOTION_BIT = 32;
const WHEEL_BIT = 64;

const SGR_PREFIX = Buffer.from('\u001b[<', 'ascii');
const X10_PREFIX = Buffer.from('\u001b[M', 'ascii');

function classifyMouseType(baseButton: number, final: 'M' | 'm'): MouseEventType {
  if ((baseButton & MOTION_BIT) !== 0) return 'move';
  if (baseButton === 3) return 'release';
  return final === 'm' ? 'release' : 'press';
}

function createMouseEvent(
  btn: number,
  x: number,
  y: number,
  final: 'M' | 'm',
): MouseEvent | undefined {
  const baseButton = btn & ~(4 | 8 | 16);
  const modifiers = {
    shift: (btn & 4) !== 0,
    meta: (btn & 8) !== 0,
    ctrl: (btn & 16) !== 0,
  };

  if (baseButton === 64 || baseButton === 65) {
    return {
      type: baseButton === 64 ? 'wheel-up' : 'wheel-down',
      x,
      y,
      button: baseButton,
      ...modifiers,
    };
  }
  if ((baseButton & WHEEL_BIT) !== 0) return undefined;

  return {
    type: classifyMouseType(baseButton, final),
    x,
    y,
    button: baseButton & ~MOTION_BIT,
    ...modifiers,
  };
}

function startsWithBytes(source: Buffer, expected: Buffer): boolean {
  return source.length >= expected.length && source.subarray(0, expected.length).equals(expected);
}

function isDigitByte(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

type MouseRead =
  | { kind: 'complete'; length: number; event: MouseEvent | undefined }
  | { kind: 'incomplete' };

export function readX10Mouse(source: Buffer): MouseRead | undefined {
  if (!startsWithBytes(source, X10_PREFIX)) return undefined;
  if (source.length < 6) return { kind: 'incomplete' };
  return {
    kind: 'complete',
    length: 6,
    event: createMouseEvent(
      source.readUInt8(3) - 32,
      source.readUInt8(4) - 32,
      source.readUInt8(5) - 32,
      'M',
    ),
  };
}

export function readSgrMouse(source: Buffer): MouseRead | undefined {
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
        event: createMouseEvent(
          parseInt(rawBtn, 10),
          parseInt(rawX, 10),
          parseInt(rawY, 10),
          byte === 0x6d ? 'm' : 'M',
        ),
      };
    }
    if (!isDigitByte(byte) && byte !== 0x3b) return undefined;
  }

  return { kind: 'incomplete' };
}
