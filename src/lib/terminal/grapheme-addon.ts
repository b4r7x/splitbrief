import { Buffer } from 'node:buffer';

// @xterm/addon-unicode-graphemes 0.4.0 decodes its base64 trie with Buffer.from(str, 'base64')
// and hands that Buffer to `new DataView(buffer.buffer)`, ignoring the Buffer's byteOffset into
// Node's shared pool — whenever the trie lands mid-pool the addon inflates garbage and dies with
// `Data error` at import. A pool size of 0 gives every Buffer made during the import its own
// ArrayBuffer, so byteOffset 0 is the truth the addon assumes.
const poolSize = Buffer.poolSize;
Buffer.poolSize = 0;
const loaded = await import('@xterm/addon-unicode-graphemes').finally(() => {
  Buffer.poolSize = poolSize;
});
const addon = loaded.default ?? loaded;
export const UnicodeGraphemesAddon = addon.UnicodeGraphemesAddon;
