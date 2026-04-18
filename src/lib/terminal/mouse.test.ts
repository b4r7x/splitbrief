import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { parseMouseEvents, createFilteredStdin, type MouseEvent } from './mouse.js';

describe('parseMouseEvents', () => {
  it('intercepts wheel-up events and removes them from the clean stream', () => {
    const input = `before\u001b[<0;10;20Mmiddle\u001b[<64;10;20Mafter`;
    const { events, clean } = parseMouseEvents(input);

    expect(clean).toBe(`before\u001b[<0;10;20Mmiddleafter`);
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

  it('passes non-wheel SGR mouse sequences through untouched', () => {
    const press = '\u001b[<0;5;10M';
    const release = '\u001b[<0;5;10m';
    const input = `${press}text${release}`;
    const { events, clean } = parseMouseEvents(input);

    expect(events).toEqual([]);
    expect(clean).toBe(input);
  });

  it('passes non-wheel sequences with modifier bits through untouched', () => {
    const seq = '\u001b[<4;1;1M';
    const { events, clean } = parseMouseEvents(seq);

    expect(events).toEqual([]);
    expect(clean).toBe(seq);
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

    expect(clean).toBe('\u001b[<0;1;1Mhelloworld\u001b[<1;4;5M');
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

async function readFiltered(stream: NodeJS.ReadStream, bytes: number, timeoutMs = 200): Promise<string> {
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
    filtered.onMouse(e => events.push(e));

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
    filtered.onMouse(e => events.push(e));

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
    filtered.onMouse(e => events.push(e));

    fakeStdin.emit('data', Buffer.from('hello world'));

    const clean = await readFiltered(filtered.stdin, 'hello world'.length);

    expect(clean).toBe('hello world');
    expect(events).toEqual([]);

    filtered.disable();
  });

  it('delivers multiple consecutive wheel events from a single chunk in order', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse(e => events.push(e));

    fakeStdin.emit('data', Buffer.from('\u001b[<64;1;1M\u001b[<65;2;2Mtail'));

    const clean = await readFiltered(filtered.stdin, 'tail'.length);

    expect(clean).toBe('tail');
    expect(events.map(e => e.type)).toEqual(['wheel-up', 'wheel-down']);
    expect(events[0]).toMatchObject({ x: 1, y: 1 });
    expect(events[1]).toMatchObject({ x: 2, y: 2 });

    filtered.disable();
  });

  it('withholds a partial escape sequence at the very end of a chunk until completion', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    const collected: string[] = [];
    filtered.onMouse(e => events.push(e));
    filtered.stdin.on('data', (chunk: Buffer) => collected.push(chunk.toString('utf8')));

    fakeStdin.emit('data', Buffer.from('prefix\u001b[<64;'));
    // After the first chunk: 'prefix' is visible, escape tail held back — no event yet.
    await new Promise(r => setTimeout(r, 10));
    expect(collected.join('')).toBe('prefix');
    expect(events).toEqual([]);

    fakeStdin.emit('data', Buffer.from('5;6Mdone'));
    await new Promise(r => setTimeout(r, 10));

    expect(collected.join('')).toBe('prefixdone');
    expect(events).toEqual([
      { type: 'wheel-up', x: 5, y: 6, button: 64, shift: false, meta: false, ctrl: false },
    ]);

    filtered.disable();
  });

  it('does not buffer trailing plain escape characters that cannot start a mouse sequence', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const events: MouseEvent[] = [];
    filtered.onMouse(e => events.push(e));

    // `\u001b` alone (e.g. from an Alt-key press) does not match the partial
    // mouse pattern `^\u001b\[<[\d;]*$`; it must pass through unchanged.
    fakeStdin.emit('data', Buffer.from('ab\u001b'));

    const clean = await readFiltered(filtered.stdin, 'ab\u001b'.length);
    expect(clean).toBe('ab\u001b');
    expect(events).toEqual([]);

    filtered.disable();
  });

  it('removes a listener when its unsubscribe is called and keeps receiving other listeners', async () => {
    const fakeStdin = makeFakeStdin();
    const filtered = createFilteredStdin(fakeStdin);
    const a: MouseEvent[] = [];
    const b: MouseEvent[] = [];
    const unsubA = filtered.onMouse(e => a.push(e));
    filtered.onMouse(e => b.push(e));

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
    filtered.onMouse(e => events.push(e));

    filtered.disable();
    // After disable, emitting data on the real stdin must not produce events.
    fakeStdin.emit('data', Buffer.from('\u001b[<64;1;1M'));

    expect(events).toEqual([]);
    // Idempotent — second disable must not throw.
    expect(() => filtered.disable()).not.toThrow();
  });
});
