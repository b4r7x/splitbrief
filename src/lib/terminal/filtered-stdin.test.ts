import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  parseMouseEvents,
  createFilteredStdin,
  stripPasteMarkers,
  type MouseEvent,
} from './filtered-stdin.js';

describe('parseMouseEvents', () => {
  it('intercepts wheel-up events and removes them from the clean stream', () => {
    const input = `before\u001b[<0;10;20Mmiddle\u001b[<64;10;20Mafter`;
    const { events, clean } = parseMouseEvents(input);

    expect(clean).toBe('beforemiddleafter');
    expect(events).toEqual([
      { type: 'wheel-up', x: 10, y: 20, button: 64, shift: false, meta: false, ctrl: false },
    ]);
  });

  it('intercepts wheel-down events and removes them from the clean stream', () => {
    const { events, clean } = parseMouseEvents(`\u001b[<65;3;7Mtext`);

    expect(clean).toBe('text');
    expect(events).toEqual([
      { type: 'wheel-down', x: 3, y: 7, button: 65, shift: false, meta: false, ctrl: false },
    ]);
  });

  it('strips non-wheel SGR mouse sequences without emitting events', () => {
    const press = '\u001b[<0;5;10M';
    const release = '\u001b[<0;5;10m';
    const input = `${press}text${release}`;
    const { events, clean } = parseMouseEvents(input);

    expect(events).toEqual([]);
    expect(clean).toBe('text');
  });

  it('strips non-wheel sequences with modifier bits', () => {
    const seq = '\u001b[<4;1;1M';
    const { events, clean } = parseMouseEvents(seq);

    expect(events).toEqual([]);
    expect(clean).toBe('');
  });

  it('intercepts wheel events with modifier bits using the masked button code', () => {
    const { events, clean } = parseMouseEvents('\u001b[<68;2;3M');
    expect(clean).toBe('');
    expect(events).toEqual([
      { type: 'wheel-up', x: 2, y: 3, button: 64, shift: true, meta: false, ctrl: false },
    ]);
  });

  it('strips unsupported extended wheel codes silently', () => {
    const { events, clean } = parseMouseEvents(`before\u001b[<66;1;2Mafter`);

    expect(clean).toBe('beforeafter');
    expect(events).toEqual([]);
  });

  it('handles mixed non-wheel, wheel, and plain text correctly', () => {
    const input = '\u001b[<0;1;1Mhello\u001b[<64;2;3Mworld\u001b[<1;4;5M';
    const { events, clean } = parseMouseEvents(input);

    expect(clean).toBe('helloworld');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('wheel-up');
  });
});

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

describe('createFilteredStdin partial chunk handling (splitMouseChunk)', () => {
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
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

  it('strips click reports from filtered stdin without reporting scroll events', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse((e) => events.push(e));

    fakeStdin.emit('data', Buffer.from('a\u001b[<0;3;4Mb\u001b[<2;5;6Mc'));

    const clean = await readFiltered(filtered.stdin, 'abc'.length);

    expect(clean).toBe('abc');
    expect(events).toEqual([]);

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

  it('strips a non-wheel click report split across chunks', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse((e) => events.push(e));

    const cleanPromise = readFiltered(filtered.stdin, 'leftright'.length);
    fakeStdin.emit('data', Buffer.from('left\u001b[<0;5'));
    fakeStdin.emit('data', Buffer.from(';6Mright'));

    await expect(cleanPromise).resolves.toBe('leftright');
    expect(events).toEqual([]);

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
    await new Promise((r) => setTimeout(r, 30));
    expect(collected.join('')).toBe('left\u001b');

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

  // A bare \x1b is a valid prefix of both the bracketed-paste start marker (\x1b[200~)
  // and a partial SGR mouse sequence; these pin that a lone Escape keypress still reaches
  // the consumer immediately instead of being withheld by the partial buffers.
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
    // The filter does not buffer or reassemble: it forwards the lone ESC immediately and the
    // [A tail separately, so the Up-arrow bytes survive in order for the downstream parser.
    expect(delivered).toEqual([0x1b, 0x5b, 0x41]);
  });
});

describe('stripPasteMarkers', () => {
  it('removes a start/end pair and keeps the content, ending inactive', () => {
    const result = stripPasteMarkers('\u001b[200~hello world\u001b[201~', false);
    expect(result.clean).toBe('hello world');
    expect(result.pasteActive).toBe(false);
    expect(result.partial).toBe('');
  });

  it('marks paste active after a lone start marker', () => {
    const result = stripPasteMarkers('\u001b[200~partial line', false);
    expect(result.clean).toBe('partial line');
    expect(result.pasteActive).toBe(true);
    expect(result.partial).toBe('');
  });

  it('clears paste active when a previously-open paste ends', () => {
    const result = stripPasteMarkers('rest of paste\u001b[201~after', true);
    expect(result.clean).toBe('rest of pasteafter');
    expect(result.pasteActive).toBe(false);
    expect(result.partial).toBe('');
  });

  it('preserves text content unchanged when there are no markers', () => {
    const result = stripPasteMarkers('plain typed text', false);
    expect(result.clean).toBe('plain typed text');
    expect(result.pasteActive).toBe(false);
    expect(result.partial).toBe('');
  });

  it('holds back a trailing partial marker that the mouse layer would not catch', () => {
    const result = stripPasteMarkers('text\u001b[20', false);
    expect(result.clean).toBe('text');
    expect(result.partial).toBe('\u001b[20');
  });

  it('reflects the last marker when a chunk ends then immediately starts a paste', () => {
    const result = stripPasteMarkers('\u001b[201~mid\u001b[200~tail', true);
    expect(result.clean).toBe('midtail');
    expect(result.pasteActive).toBe(true);
  });

  it('does not hold back a complete escape sequence that is not a paste prefix', () => {
    const result = stripPasteMarkers('text\u001b[A', false);
    expect(result.clean).toBe('text\u001b[A');
    expect(result.partial).toBe('');
  });

  it('holds a lone trailing ESC as a partial so a split paste marker can reassemble', () => {
    const result = stripPasteMarkers('\u001b', false);
    // A lone trailing ESC may head a split `[200~`/`[201~` marker, so it is held one chunk
    // and re-prepended to the next chunk rather than leaking the marker body into the stream.
    expect(result.clean).toBe('');
    expect(result.partial).toBe('\u001b');
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

    // The mouse layer does not hold back `\u001b[20`, so the paste layer must.
    fakeStdin.emit('data', Buffer.from('before\u001b[20'));
    await new Promise((r) => setTimeout(r, 10));
    expect(collected.join('')).toBe('before');
    expect(filtered.isPasteActive()).toBe(false);

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

  it('keeps a raw ESC inside pasted content out of the key stream', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const collected: string[] = [];
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('\u001b[200~ab\u001b[201~'));
    await new Promise((r) => setTimeout(r, 10));

    expect(collected.join('')).toBe('ab');
    expect(filtered.isPasteActive()).toBe(false);

    filtered.disable();
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
});
