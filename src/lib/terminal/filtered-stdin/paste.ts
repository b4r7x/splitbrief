export const PASTE_START = '\u001b[200~';
export const PASTE_END = '\u001b[201~';
export const PASTE_START_BYTES = Buffer.from(PASTE_START, 'ascii');
export const PASTE_END_BYTES = Buffer.from(PASTE_END, 'ascii');
export const EMPTY_BUFFER = Buffer.alloc(0);

// biome-ignore-start lint/suspicious/noControlCharactersInRegex: matches ANSI escape bytes in terminal input
const PASTE_BODY_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001bO[@-~]|\u001b/g;
const PASTE_BODY_UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: matches ANSI escape bytes in terminal input

export function sanitizePasteBody(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(PASTE_BODY_ESCAPE_RE, '')
    .replace(PASTE_BODY_UNSAFE_CONTROL_RE, '');
}

export interface PasteScan {
  bytes: Buffer;
  pendingCr: boolean;
}

export function sanitizePasteBytes(body: Buffer, pendingCr = false): PasteScan {
  const clean: number[] = [];
  let carriedCr = pendingCr;
  for (let i = 0; i < body.length; i++) {
    const byte = body.readUInt8(i);
    if (byte === 0x0d) {
      clean.push(0x0a);
      carriedCr = true;
      continue;
    }
    if (byte === 0x0a) {
      if (!carriedCr) clean.push(0x0a);
      carriedCr = false;
      continue;
    }
    carriedCr = false;
    if (byte === 0x09 || (byte >= 0x20 && byte !== 0x7f)) clean.push(byte);
  }
  return { bytes: Buffer.from(clean), pendingCr: carriedCr };
}

function isPrefixOfBytes(source: Buffer, expected: Buffer): boolean {
  return source.length < expected.length && expected.subarray(0, source.length).equals(source);
}

export function isPasteMarkerPrefix(source: Buffer): boolean {
  return isPrefixOfBytes(source, PASTE_START_BYTES) || isPrefixOfBytes(source, PASTE_END_BYTES);
}
