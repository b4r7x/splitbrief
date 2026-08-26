import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import type { MouseEvent } from './types.js';
import { createFilteredStdin } from './create.js';
import { terminalSequences } from '../control.js';

function x10MouseSequence(button: number, x: number, y: number): string {
  return `\u001b[M${String.fromCharCode(button + 32)}${String.fromCharCode(x + 32)}${String.fromCharCode(y + 32)}`;
}

function x10MouseBytes(button: number, x: number, y: number): Buffer {
  return Buffer.from([0x1b, 0x5b, 0x4d, button + 32, x + 32, y + 32]);
}

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

async function readFiltered(
  stream: NodeJS.ReadStream,
  bytes: number,
  timeoutMs = 200,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (buf.length >= bytes) {
        stream.off('data', onData);
        resolve(buf);
      }
    };
    stream.on('data', onData);
    setTimeout(() => {
      stream.off('data', onData);
      resolve(buf);
    }, timeoutMs);
    stream.on('error', reject);
  });
}

describe('createFilteredStdin input filtering', () => {
  let originalWrite: typeof process.stdout.write;
  let written: string[];

  beforeEach(() => {
    originalWrite = process.stdout.write.bind(process.stdout);
    written = [];
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('reassembles a wheel event when the escape sequence is split across two chunks', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse((e) => events.push(e));

    fakeStdin.emit('data', Buffer.from('hello\u001b[<64;10'));
    fakeStdin.emit('data', Buffer.from(';20Mworld'));

    const clean = await readFiltered(filtered.stdin, 'helloworld'.length);

    expect(clean).toBe('helloworld');
    expect(events).toEqual([
      { type: 'wheel-up', x: 10, y: 20, button: 64, shift: false, meta: false, ctrl: false },
    ]);

    filtered.disable();
  });

  it('can be created without activating terminal input modes until requested', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin, { activate: false });

    fakeStdin.emit('data', Buffer.from('before'));
    expect(await readFiltered(filtered.stdin, 'before'.length, 20)).toBe('');
    expect(written).not.toContain(terminalSequences.enableMouseTracking);

    filtered.activate();
    fakeStdin.emit('data', Buffer.from('after'));

    expect(await readFiltered(filtered.stdin, 'after'.length)).toBe('after');
    expect(written).toContain(terminalSequences.enableMouseTracking);

    filtered.disable();
  });

  it('emits a complete wheel event that arrives in a single chunk without buffering', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse((e) => events.push(e));

    fakeStdin.emit('data', Buffer.from('a\u001b[<65;1;1Mb'));

    const clean = await readFiltered(filtered.stdin, 'ab'.length);

    expect(clean).toBe('ab');
    expect(events).toEqual([
      { type: 'wheel-down', x: 1, y: 1, button: 65, shift: false, meta: false, ctrl: false },
    ]);

    filtered.disable();
  });

  it('parses raw X10 mouse bytes before UTF-8 decoding and keeps trailing text', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse((e) => events.push(e));

    fakeStdin.emit(
      'data',
      Buffer.concat([Buffer.from('left'), x10MouseBytes(64, 100, 20), Buffer.from('tail')]),
    );

    const clean = await readFiltered(filtered.stdin, 'lefttail'.length);

    expect(clean).toBe('lefttail');
    expect(events).toEqual([
      { type: 'wheel-up', x: 100, y: 20, button: 64, shift: false, meta: false, ctrl: false },
    ]);

    filtered.disable();
  });

  it('reassembles a multibyte UTF-8 character split across two raw chunks', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);

    // '😀' is U+1F600, four UTF-8 bytes. Splitting it mid-sequence must not produce
    // replacement characters: the StringDecoder buffers the leading bytes until the rest lands.
    const emoji = Buffer.from('😀', 'utf8');
    const cleanPromise = readFiltered(filtered.stdin, '😀'.length);
    fakeStdin.emit('data', emoji.subarray(0, 2));
    fakeStdin.emit('data', emoji.subarray(2));

    await expect(cleanPromise).resolves.toBe('😀');

    filtered.disable();
  });

  it('passes plain text chunks through when no escape sequence is present', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse((e) => events.push(e));

    fakeStdin.emit('data', Buffer.from('hello world'));

    const clean = await readFiltered(filtered.stdin, 'hello world'.length);

    expect(clean).toBe('hello world');
    expect(events).toEqual([]);

    filtered.disable();
  });

  it('strips click reports from filtered stdin and surfaces them as press events', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse((e) => events.push(e));

    fakeStdin.emit('data', Buffer.from('a\u001b[<0;3;4Mb\u001b[<2;5;6Mc'));

    const clean = await readFiltered(filtered.stdin, 'abc'.length);

    expect(clean).toBe('abc');
    expect(events).toEqual([
      { type: 'press', x: 3, y: 4, button: 0, shift: false, meta: false, ctrl: false },
      { type: 'press', x: 5, y: 6, button: 2, shift: false, meta: false, ctrl: false },
    ]);

    filtered.disable();
  });

  it('surfaces a raw X10 button-3 report as a release event', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse((e) => events.push(e));

    fakeStdin.emit(
      'data',
      Buffer.concat([Buffer.from('a'), x10MouseBytes(3, 5, 6), Buffer.from('b')]),
    );

    const clean = await readFiltered(filtered.stdin, 'ab'.length);

    expect(clean).toBe('ab');
    expect(events).toEqual([
      { type: 'release', x: 5, y: 6, button: 3, shift: false, meta: false, ctrl: false },
    ]);

    filtered.disable();
  });

  it('delivers multiple consecutive wheel events from a single chunk in order', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse((e) => events.push(e));

    fakeStdin.emit('data', Buffer.from('\u001b[<64;1;1M\u001b[<65;2;2Mtail'));

    const clean = await readFiltered(filtered.stdin, 'tail'.length);

    expect(clean).toBe('tail');
    expect(events.map((e) => e.type)).toEqual(['wheel-up', 'wheel-down']);
    expect(events[0]).toMatchObject({ x: 1, y: 1 });
    expect(events[1]).toMatchObject({ x: 2, y: 2 });

    filtered.disable();
  });

  it('withholds a partial escape sequence at the very end of a chunk until completion', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    const collected: string[] = [];
    filtered.onMouse((e) => events.push(e));
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('prefix\u001b[<64;'));
    // After the first chunk: 'prefix' is visible, escape tail held back — no event yet.
    await new Promise((r) => setTimeout(r, 10));
    expect(collected.join('')).toBe('prefix');
    expect(events).toEqual([]);

    fakeStdin.emit('data', Buffer.from('5;6Mdone'));
    await new Promise((r) => setTimeout(r, 10));

    expect(collected.join('')).toBe('prefixdone');
    expect(events).toEqual([
      { type: 'wheel-up', x: 5, y: 6, button: 64, shift: false, meta: false, ctrl: false },
    ]);

    filtered.disable();
  });

  it('reassembles a non-wheel click report split across chunks into one press event', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse((e) => events.push(e));

    const cleanPromise = readFiltered(filtered.stdin, 'leftright'.length);
    fakeStdin.emit('data', Buffer.from('left\u001b[<0;5'));
    fakeStdin.emit('data', Buffer.from(';6Mright'));

    await expect(cleanPromise).resolves.toBe('leftright');
    expect(events).toEqual([
      { type: 'press', x: 5, y: 6, button: 0, shift: false, meta: false, ctrl: false },
    ]);

    filtered.disable();
  });

  it('holds a lone trailing ESC briefly, then flushes it as a real Escape keypress', async () => {
    // A trailing ESC may head a split paste marker, so the preceding content flushes now and
    // the ESC is held one chunk. With no continuation it flushes after a short delay so a real
    // Escape keypress still reaches the consumer rather than freezing the key.
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('left\u001b'));
    await new Promise((r) => setTimeout(r, 80));
    expect(collected.join('')).toBe('left\u001b');

    filtered.disable();
  });

  it('holds a longer marker-prefix briefly, then flushes the whole remainder as one chunk', async () => {
    // `\u001b[2` is a paste-marker prefix the mouse layer does not catch (no `<`), so the paste
    // layer holds it for one chunk in case `[200~`/`[201~` is split. With no continuation the
    // entire held remainder must flush as its own chunk rather than being withheld forever and
    // later merged into the next keypress.
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const chunks: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('left\u001b[2'));
    await new Promise((r) => setTimeout(r, 45));

    expect(chunks.join('')).toBe('left\u001b[2');
    expect(chunks).toContain('\u001b[2');

    filtered.disable();
  });

  it('does not merge a flushed held prefix with a later unrelated keypress', async () => {
    // Before the fix, a longer held prefix was withheld indefinitely and then merged with the
    // next chunk, so `\u001b[2` + a later `x` re-parsed as a single corrupted sequence. The
    // flush timer must emit the held prefix on its own so the subsequent key stays separate.
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const chunks: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('\u001b[2'));
    await new Promise((r) => setTimeout(r, 45));
    fakeStdin.emit('data', Buffer.from('x'));
    await new Promise((r) => setTimeout(r, 10));

    expect(chunks.join('')).toBe('\u001b[2x');
    expect(chunks).not.toContain('\u001b[2x');

    filtered.disable();
  });

  it('flushes an incomplete ESC[ prefix after the held-prefix delay', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const chunks: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('left\u001b['));
    await new Promise((r) => setTimeout(r, 45));

    expect(chunks.join('')).toBe('left\u001b[');

    filtered.disable();
  });

  it('flushes an incomplete ESC[M prefix after the held-prefix delay', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const chunks: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('left\u001b[M'));
    await new Promise((r) => setTimeout(r, 45));

    expect(chunks.join('')).toBe('left\u001b[M');

    filtered.disable();
  });

  it('reassembles an SGR mouse report split after a bare ESC', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse((e) => events.push(e));

    const cleanPromise = readFiltered(filtered.stdin, 'tail'.length);
    fakeStdin.emit('data', Buffer.from('\u001b'));
    fakeStdin.emit('data', Buffer.from('[<64;5;6Mtail'));

    await expect(cleanPromise).resolves.toBe('tail');
    expect(events).toEqual([
      { type: 'wheel-up', x: 5, y: 6, button: 64, shift: false, meta: false, ctrl: false },
    ]);

    filtered.disable();
  });

  it('reassembles an X10 mouse report split after a bare ESC', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse((e) => events.push(e));

    const cleanPromise = readFiltered(filtered.stdin, 'tail'.length);
    fakeStdin.emit('data', Buffer.from('\u001b'));
    fakeStdin.emit(
      'data',
      Buffer.concat([Buffer.from('[M'), x10MouseBytes(64, 7, 8).subarray(3), Buffer.from('tail')]),
    );

    await expect(cleanPromise).resolves.toBe('tail');
    expect(events).toEqual([
      { type: 'wheel-up', x: 7, y: 8, button: 64, shift: false, meta: false, ctrl: false },
    ]);

    filtered.disable();
  });

  it('withholds a mouse report split after ESC[ until completion', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    const collected: string[] = [];
    filtered.onMouse((e) => events.push(e));
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('left\u001b['));
    await new Promise((r) => setTimeout(r, 10));

    expect(collected.join('')).toBe('left');

    fakeStdin.emit('data', Buffer.from('<65;3;4Mright'));
    await new Promise((r) => setTimeout(r, 10));

    expect(collected.join('')).toBe('leftright');
    expect(events).toEqual([
      { type: 'wheel-down', x: 3, y: 4, button: 65, shift: false, meta: false, ctrl: false },
    ]);

    filtered.disable();
  });

  it('withholds an X10 mouse report split after ESC[M until completion', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    const collected: string[] = [];
    const report = x10MouseSequence(65, 3, 4);
    filtered.onMouse((e) => events.push(e));
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from(`left${report.slice(0, 3)}`));
    await new Promise((r) => setTimeout(r, 10));

    expect(collected.join('')).toBe('left');

    fakeStdin.emit('data', Buffer.from(`${report.slice(3)}right`));
    await new Promise((r) => setTimeout(r, 10));

    expect(collected.join('')).toBe('leftright');
    expect(events).toEqual([
      { type: 'wheel-down', x: 3, y: 4, button: 65, shift: false, meta: false, ctrl: false },
    ]);

    filtered.disable();
  });

  it('passes through a buffered escape once the next chunk proves it is not an SGR mouse report', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);

    const cleanPromise = readFiltered(filtered.stdin, 'ab\u001bx'.length);
    fakeStdin.emit('data', Buffer.from('ab\u001b'));
    await new Promise((r) => setTimeout(r, 10));
    fakeStdin.emit('data', Buffer.from('x'));

    await expect(cleanPromise).resolves.toBe('ab\u001bx');

    filtered.disable();
  });

  it('removes a listener when its unsubscribe is called and keeps receiving other listeners', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const a: MouseEvent[] = [];
    const b: MouseEvent[] = [];
    const unsubA = filtered.onMouse((e) => a.push(e));
    filtered.onMouse((e) => b.push(e));

    fakeStdin.emit('data', Buffer.from('\u001b[<64;1;1M'));
    unsubA();
    fakeStdin.emit('data', Buffer.from('\u001b[<65;2;2M'));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);

    filtered.disable();
  });

  it('detaches the underlying data handler after disable and stops reporting events', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse((e) => events.push(e));

    filtered.disable();
    fakeStdin.emit('data', Buffer.from('\u001b[<64;1;1M'));

    expect(events).toEqual([]);
    expect(() => filtered.disable()).not.toThrow();
  });

  it('enables terminal modes on create and disables them once', () => {
    const fakeStdin = makeFakeStdin();

    const filtered = createFilteredStdin(fakeStdin);
    filtered.disable();
    filtered.disable();

    expect(written).toEqual([
      terminalSequences.enableMouseTracking,
      terminalSequences.enableSgrMouse,
      terminalSequences.enableBracketedPaste,
      terminalSequences.disableMouseTracking,
      terminalSequences.disableButtonEventMouse,
      terminalSequences.disableAnyMotionMouse,
      terminalSequences.disableSgrMouse,
      terminalSequences.disableBracketedPaste,
    ]);
  });

  it('enables any-motion tracking for hover and clears every mouse mode on disable', () => {
    const fakeStdin = makeFakeStdin();

    const filtered = createFilteredStdin(fakeStdin, { hover: true });
    filtered.disable();

    expect(written).toEqual([
      terminalSequences.enableAnyMotionMouse,
      terminalSequences.enableSgrMouse,
      terminalSequences.enableBracketedPaste,
      terminalSequences.disableMouseTracking,
      terminalSequences.disableButtonEventMouse,
      terminalSequences.disableAnyMotionMouse,
      terminalSequences.disableSgrMouse,
      terminalSequences.disableBracketedPaste,
    ]);
    expect(written).not.toContain(terminalSequences.enableMouseTracking);
  });

  it('can enable paste filtering without mouse tracking or mouse dispatch', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin, { mouse: false });
    const events: MouseEvent[] = [];
    filtered.onMouse((e) => events.push(e));

    const cleanPromise = readFiltered(filtered.stdin, 'ok'.length);
    fakeStdin.emit('data', Buffer.from('\u001b[200~o\x03k\u001b[<64;1;1M\u001b[201~'));

    await expect(cleanPromise).resolves.toBe('ok');
    filtered.disable();

    expect(events).toEqual([]);
    expect(written).toEqual([
      terminalSequences.enableBracketedPaste,
      terminalSequences.disableBracketedPaste,
    ]);
  });
});

describe('createFilteredStdin: lone ESC delivery', () => {
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  function collectDelivered(write: (source: NodeJS.ReadStream) => void): number[] {
    const source = makeFakeStdin();
    const filtered = createFilteredStdin(source);
    const bytes: number[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => {
      for (const b of chunk) bytes.push(b);
    });
    write(source);
    filtered.disable();
    return bytes;
  }

  // A bare \x1b is a valid prefix of bracketed paste and mouse reports; these pin that
  // disable still flushes a real Escape keypress instead of dropping it.
  it('delivers a single lone ESC byte to the consumer', () => {
    const delivered = collectDelivered((source) => {
      source.emit('data', Buffer.from('\x1b'));
    });
    expect(delivered).toEqual([0x1b]);
  });

  it('delivers two lone ESC bytes when they arrive as separate chunks', () => {
    const delivered = collectDelivered((source) => {
      source.emit('data', Buffer.from('\x1b'));
      source.emit('data', Buffer.from('\x1b'));
    });
    expect(delivered).toEqual([0x1b, 0x1b]);
  });

  it('delivers a batched double ESC arriving in one chunk', () => {
    const delivered = collectDelivered((source) => {
      source.emit('data', Buffer.from('\x1b\x1b'));
    });
    expect(delivered).toEqual([0x1b, 0x1b]);
  });

  it('preserves a split escape sequence byte-for-byte without swallowing the leading ESC', () => {
    const delivered = collectDelivered((source) => {
      source.emit('data', Buffer.from('\x1b'));
      source.emit('data', Buffer.from('[A'));
    });
    expect(delivered).toEqual([0x1b, 0x5b, 0x41]);
  });
});

describe('createFilteredStdin bracketed paste handling', () => {
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('strips paste markers from the stream and reports paste state transitions', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);

    expect(filtered.isPasteActive()).toBe(false);

    const cleanPromise = readFiltered(filtered.stdin, 'pasted'.length);
    fakeStdin.emit('data', Buffer.from('\u001b[200~pasted\u001b[201~'));

    await expect(cleanPromise).resolves.toBe('pasted');
    expect(filtered.isPasteActive()).toBe(false);

    filtered.disable();
  });

  it('reports paste active between the start and end markers across chunks', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('\u001b[200~line one\n'));
    await new Promise((r) => setTimeout(r, 10));
    expect(filtered.isPasteActive()).toBe(true);
    expect(collected.join('')).toBe('line one\n');

    fakeStdin.emit('data', Buffer.from('line two\u001b[201~'));
    await new Promise((r) => setTimeout(r, 10));
    expect(filtered.isPasteActive()).toBe(false);
    expect(collected.join('')).toBe('line one\nline two');

    filtered.disable();
  });

  it('reassembles a paste start marker split across chunks (digits separated)', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    // The mouse layer does not hold back `\u001b[20`, so the paste layer must. The continuation
    // arrives in the same input burst (as a real split marker does), before the held-prefix flush
    // timer fires, so the marker reassembles instead of leaking its body.
    fakeStdin.emit('data', Buffer.from('before\u001b[20'));
    fakeStdin.emit('data', Buffer.from('0~content\u001b[201~'));
    await new Promise((r) => setTimeout(r, 10));
    expect(collected.join('')).toBe('beforecontent');
    expect(filtered.isPasteActive()).toBe(false);

    filtered.disable();
  });

  it('reassembles a paste start marker whose leading ESC arrives alone, stripping the marker', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    // The start marker leading ESC arrives alone, then its body lands in the next chunk of the
    // same input burst (before the held-ESC flush). The ESC is held so the marker reassembles
    // and its bytes never reach the editor, instead of the ESC flushing and the body leaking.
    fakeStdin.emit('data', Buffer.from('\u001b'));
    fakeStdin.emit('data', Buffer.from('[200~content\u001b[201~'));
    await new Promise((r) => setTimeout(r, 10));
    expect(collected.join('')).toBe('content');
    expect(filtered.isPasteActive()).toBe(false);

    filtered.disable();
  });

  it('reassembles an end marker whose leading ESC arrives alone, clearing pasteActive', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('\u001b[200~typed'));
    await new Promise((r) => setTimeout(r, 10));
    expect(filtered.isPasteActive()).toBe(true);
    expect(collected.join('')).toBe('typed');

    // The end marker's leading ESC arrives alone. While a paste is open the Escape key is
    // suppressed, so a bare ESC here can only head the split `\x1b[201~` end marker: it is
    // withheld one chunk rather than leaking out and leaving pasteActive stuck true.
    fakeStdin.emit('data', Buffer.from('\u001b'));
    await new Promise((r) => setTimeout(r, 10));
    expect(collected.join('')).toBe('typed');
    expect(filtered.isPasteActive()).toBe(true);

    fakeStdin.emit('data', Buffer.from('[201~'));
    await new Promise((r) => setTimeout(r, 10));
    expect(collected.join('')).toBe('typed');
    expect(filtered.isPasteActive()).toBe(false);

    filtered.disable();
  });

  it('strips ESC/CSI bytes from inside pasted content so they never reach the key stream', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    // A paste body that itself carries a CSI cursor-move and a bare two-byte escape. Forwarded
    // verbatim, Ink would explode these into synthetic keypresses (arrow/return/etc.); they must
    // be dropped so only the printable text survives.
    fakeStdin.emit('data', Buffer.from('\u001b[200~a\u001b[Bb\u001bcc\u001b[201~'));
    await new Promise((r) => setTimeout(r, 10));

    const seen = collected.join('');
    expect(seen).toBe('abcc');
    expect(seen).not.toContain('\u001b');
    expect(filtered.isPasteActive()).toBe(false);

    filtered.disable();
  });

  it('does not dispatch mouse events from bracketed paste bodies', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    const collected: string[] = [];
    filtered.onMouse((e) => events.push(e));
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit(
      'data',
      Buffer.concat([
        Buffer.from('\u001b[200~safe'),
        Buffer.from('\u001b[<64;1;2Mtext'),
        Buffer.from('\u001b[Mabc'),
        Buffer.from('done\u001b[201~'),
      ]),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(collected.join('')).toBe('safetextabcdone');
    expect(events).toEqual([]);
    expect(filtered.isPasteActive()).toBe(false);

    filtered.disable();
  });

  it('never emits a bare carriage return mid-paste, converting it to a newline', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    // Single-chunk regime: an entire bracketed paste whose body holds CR and CRLF line breaks. A
    // bare \r reaching Ink is parsed as a Return keypress and fires the composer's submit (and the
    // approval/cost gates) mid-paste, so the filter must rewrite every CR to a newline.
    fakeStdin.emit('data', Buffer.from('\u001b[200~line one\rline two\r\nline three\u001b[201~'));
    await new Promise((r) => setTimeout(r, 10));

    const seen = collected.join('');
    expect(seen).not.toContain('\r');
    expect(seen).toBe('line one\nline two\nline three');
    expect(filtered.isPasteActive()).toBe(false);

    filtered.disable();
  });

  it('strips unsafe paste controls while preserving LF and tab', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('\u001b[200~a\x03b\x04c\x08d\x1ae\x7ff\n\tg\u001b[201~'));
    await new Promise((r) => setTimeout(r, 10));

    expect(collected.join('')).toBe('abcdef\n\tg');

    filtered.disable();
  });

  it('keeps a delayed paste start marker pending beyond the base held-prefix delay', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('\u001b'));
    await new Promise((r) => setTimeout(r, 45));
    fakeStdin.emit('data', Buffer.from('[200~a\rb\u001b[201~'));
    await new Promise((r) => setTimeout(r, 10));

    expect(collected.join('')).toBe('a\nb');
    expect(collected.join('')).not.toContain('\r');
    expect(filtered.isPasteActive()).toBe(false);

    filtered.disable();
  });

  it('drains decoder-held UTF-8 bytes on disable', () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    const emoji = Buffer.from('😀', 'utf8');
    fakeStdin.emit('data', emoji.subarray(0, 2));
    filtered.disable();

    expect(collected.join('')).toBe('\uFFFD');
  });

  it('drops a paste-held escape prefix on disable after emitting paste body text', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('\u001b[200~abc\u001b'));
    await new Promise((r) => setTimeout(r, 10));
    filtered.disable();

    expect(collected.join('')).toBe('abc');
    expect(collected.join('')).not.toContain('\u001b');
    expect(filtered.isPasteActive()).toBe(false);
  });

  it('resets paste state on disable', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);

    fakeStdin.emit('data', Buffer.from('\u001b[200~open'));
    await new Promise((r) => setTimeout(r, 10));
    expect(filtered.isPasteActive()).toBe(true);

    filtered.disable();
    expect(filtered.isPasteActive()).toBe(false);
  });

  it('folds CRLF to LF, strips embedded escapes and C0 bytes, and leaves no ESC (T-030)', async () => {
    // A CRLF reaching Ink would fire the composer submit / approval gates mid-paste, and a leaked
    // ESC would explode into synthetic keypresses. A single paste that mixes a CRLF line break, an
    // embedded CSI cursor-move, and C0 control bytes must emerge as printable text with LF only.
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('\u001b[200~a\r\nb\u001b[Cc\x00\x07d\u001b[201~'));
    await new Promise((r) => setTimeout(r, 10));

    const seen = collected.join('');
    expect(seen).toBe('a\nbcd');
    expect(seen).toContain('\n');
    expect(seen).not.toContain('\r');
    expect(seen).not.toContain('\x1b');
    expect(filtered.isPasteActive()).toBe(false);

    filtered.disable();
  });

  it('decodes a tmux CSI-u CR/LF re-encoding inside a paste to a newline (REQ-052, T-030)', async () => {
    // Under tmux extended-keys, CR/LF can arrive re-encoded as CSI-u (e.g. `\u001b[13u` for CR,
    // `[10u` for LF, or a modified variant `[13;5u`). These are decoded to LF before
    // sanitizing so pasted line breaks survive as newlines (REQ-052) — while no raw ESC leaks.
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit(
      'data',
      Buffer.from('\u001b[200~x\u001b[13uy\u001b[10uz\u001b[13;5uw\u001b[201~'),
    );
    await new Promise((r) => setTimeout(r, 10));

    const seen = collected.join('');
    expect(seen).toBe('x\ny\nz\nw');
    expect(seen).not.toContain('\x1b');
    expect(filtered.isPasteActive()).toBe(false);

    filtered.disable();
  });

  it('still strips a non-line-break tmux CSI-u re-encoding inside a paste (T-030)', async () => {
    // A CSI-u for a printable key (e.g. `\u001b[97u` = 'a') is not a line break, so it is
    // dropped whole like any other in-paste escape - only CR/LF re-encodings become newlines.
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('\u001b[200~x\u001b[97uy\u001b[201~'));
    await new Promise((r) => setTimeout(r, 10));

    const seen = collected.join('');
    expect(seen).toBe('xy');
    expect(seen).not.toContain('\x1b');
    expect(filtered.isPasteActive()).toBe(false);

    filtered.disable();
  });
});
