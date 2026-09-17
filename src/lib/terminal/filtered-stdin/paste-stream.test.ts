import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFilteredStdin } from './create.js';
import { PASTE_END, PASTE_START } from './paste.js';

function makeFakeStdin(): NodeJS.ReadStream {
  const pt = new PassThrough();
  Object.assign(pt, {
    isTTY: false,
    isRaw: false,
    setRawMode: () => pt,
    ref: () => pt,
    unref: () => pt,
  });
  return pt as unknown as NodeJS.ReadStream;
}

function splitBuffer(source: Buffer, at: number): Buffer[] {
  return [source.subarray(0, at), source.subarray(at)].filter((part) => part.length > 0);
}

function everyByteAlone(source: Buffer): Buffer[] {
  return Array.from(source, (byte) => Buffer.from([byte]));
}

async function drive(chunks: Buffer[], options?: { leaveOpen?: boolean }): Promise<string> {
  const fakeStdin = makeFakeStdin();
  const filtered = createFilteredStdin(fakeStdin);
  const collected: string[] = [];
  filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

  for (const chunk of chunks) fakeStdin.emit('data', chunk);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(filtered.isPasteActive()).toBe(options?.leaveOpen === true);

  filtered.disable();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return collected.join('');
}

describe('bracketed paste is independent of how its bytes are split', () => {
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('emits the same text for every split position of a CRLF paste', async () => {
    // The body mixes a CRLF line break with a trailing lone LF, so a split can land between the
    // CR and the LF (which must still fold to one newline) and on a newline-only chunk (which
    // must survive). Every split of the same bytes owes the same insertion.
    const paste = Buffer.from(`${PASTE_START}a\r\nb\n${PASTE_END}`, 'utf8');
    const crIndex = paste.indexOf(0x0d);
    expect(paste.readUInt8(crIndex + 1)).toBe(0x0a);

    expect(await drive([paste])).toBe('a\nb\n');

    for (let at = 1; at < paste.length; at++) {
      const seen = await drive(splitBuffer(paste, at));
      expect({ at, seen }).toEqual({ at, seen: 'a\nb\n' });
    }

    expect(await drive(everyByteAlone(paste))).toBe('a\nb\n');
  });

  it('keeps an isolated newline chunk and a CR|LF chunk boundary to one newline each', async () => {
    const seen = await drive([
      Buffer.from(`${PASTE_START}a\r`, 'utf8'),
      Buffer.from('\nb', 'utf8'),
      Buffer.from('\n', 'utf8'),
      Buffer.from(PASTE_END, 'utf8'),
    ]);

    expect(seen).toBe('a\nb\n');
  });

  it('keeps a multibyte character whole however its bytes and markers are split', async () => {
    // A four-byte emoji between two three-byte CJK characters: a split inside either encoding,
    // or inside the start/end marker, must not corrupt the text or leak marker bytes.
    const paste = Buffer.from(`${PASTE_START}日\u{1f600}本${PASTE_END}`, 'utf8');

    for (let at = 1; at < paste.length; at++) {
      const seen = await drive(splitBuffer(paste, at));
      expect({ at, seen }).toEqual({ at, seen: '日\u{1f600}本' });
    }

    const byteByByte = await drive(everyByteAlone(paste));
    expect(byteByByte).toBe('日\u{1f600}本');
    expect(byteByByte).not.toContain('�');
    expect(byteByByte).not.toContain('~');
  });

  it('keeps surrounding key input in order around a split paste', async () => {
    const seen = await drive([
      Buffer.from(`before${PASTE_START}pas`, 'utf8'),
      Buffer.from(`ted${PASTE_END}after`, 'utf8'),
    ]);

    expect(seen).toBe('beforepastedafter');
  });

  it('discards an unterminated paste on disable instead of submitting it', async () => {
    // The paste never closes: its body - a carriage return included - stays buffered, so disable
    // drops it rather than letting a bare CR reach Ink as a Return keypress.
    const seen = await drive([Buffer.from(`${PASTE_START}half\rtyped`, 'utf8')], {
      leaveOpen: true,
    });

    expect(seen).toBe('');
  });

  it('leaves an ordinary Enter outside a paste as key input', async () => {
    const seen = await drive([
      Buffer.from('a\r', 'utf8'),
      Buffer.from(`\r${PASTE_START}b\rc${PASTE_END}\r`, 'utf8'),
    ]);

    expect(seen).toBe('a\r\rb\nc\r');
  });

  it('strips in-paste escapes and unsafe controls at every split position', async () => {
    const paste = Buffer.from(`${PASTE_START}a\u001b[Bb\u0000c\u007f\td${PASTE_END}`, 'utf8');

    for (let at = 1; at < paste.length; at++) {
      const seen = await drive(splitBuffer(paste, at));
      expect({ at, seen }).toEqual({ at, seen: 'abc\td' });
    }
  });
});
