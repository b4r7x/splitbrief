import { Buffer } from 'node:buffer';

// @xterm/addon-unicode-graphemes 0.4.0 decodes its base64 trie with Buffer.from(str, 'base64')
// and hands that Buffer to `new DataView(buffer.buffer)`, ignoring the Buffer's byteOffset into
// Node's shared pool — whenever the trie lands mid-pool the addon inflates garbage and dies with
// `Data error` at import. Finishing the current pool first makes the trie the first allocation
// of a fresh one, where byteOffset 0 is the truth the addon assumes.
function finishBufferPool(): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const cursor = Buffer.allocUnsafe(1).byteOffset;
    if (Buffer.poolSize - cursor < 1024) return;
    Buffer.allocUnsafe(Math.min(Buffer.poolSize - cursor - 1023, Buffer.poolSize >>> 1));
  }
}

finishBufferPool();

const loaded = await import('@xterm/addon-unicode-graphemes');
const addon = loaded.default ?? loaded;
export const UnicodeGraphemesAddon = addon.UnicodeGraphemesAddon;
