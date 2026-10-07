import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseBackgroundReply, queryTerminalBackground } from './background.js';

const OSC_11_QUERY = '\u001b]11;?\u001b\\';
const DA1_QUERY = '\u001b[c';
const DA1_REPLY = '\u001b[?62;22c';

function fakeTerminal(): {
  input: NodeJS.ReadStream;
  output: NodeJS.WritableStream;
  written: () => string;
  rawModes: boolean[];
  reply: (text: string) => void;
} {
  const rawModes: boolean[] = [];
  const stream = new PassThrough();
  const input = Object.assign(stream, {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean): PassThrough {
      rawModes.push(mode);
      Object.assign(stream, { isRaw: mode });
      return stream;
    },
  });
  const chunks: string[] = [];
  const output = new PassThrough();
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  return {
    input: input as unknown as NodeJS.ReadStream,
    output,
    written: () => chunks.join(''),
    rawModes,
    reply: (text) => stream.write(text),
  };
}

describe('parseBackgroundReply', () => {
  it.each([
    ['\u001b]11;rgb:2424/2727/3a3a\u001b\\', '#24273a'],
    ['\u001b]11;rgb:2424/2727/3a3a\u0007', '#24273a'],
    ['\u001b]11;rgb:24/27/3a\u0007', '#24273a'],
    ['\u001b]11;rgb:ffff/ffff/ffff\u001b\\', '#ffffff'],
    ['\u001b]11;rgb:f/f/f\u0007', '#ffffff'],
    [`\u001b]11;rgb:fdfd/f6f6/e3e3\u001b\\${DA1_REPLY}`, '#fdf6e3'],
  ])('reads %j as %s', (reply, hex) => {
    expect(parseBackgroundReply(reply)).toBe(hex);
  });

  it.each([
    [DA1_REPLY],
    ['\u001b]11;?\u001b\\'],
    ['\u001b]10;rgb:ffff/ffff/ffff\u0007'],
    ['hello'],
  ])('finds no background in %j', (reply) => {
    expect(parseBackgroundReply(reply)).toBeUndefined();
  });
});

describe('queryTerminalBackground', () => {
  it.each([true, false])(
    'continues without a background when setRawMode(%s) throws',
    async (mode) => {
      const terminal = fakeTerminal();
      const setRawMode = terminal.input.setRawMode.bind(terminal.input);
      terminal.input.setRawMode = (next) => {
        if (next === mode) throw new Error('raw mode unavailable');
        return setRawMode(next);
      };
      const pending = queryTerminalBackground(terminal.input, terminal.output, 1_000);
      terminal.reply(`\u001b]11;rgb:ffff/ffff/ffff\u0007${DA1_REPLY}`);

      await expect(pending).resolves.toBeUndefined();
      expect(terminal.input.listenerCount('data')).toBe(0);
      expect(terminal.input.isPaused()).toBe(true);
    },
  );

  it('asks for the background and the device attributes, and reads the reply', async () => {
    const terminal = fakeTerminal();
    const pending = queryTerminalBackground(terminal.input, terminal.output, 1_000);
    terminal.reply(`\u001b]11;rgb:2424/2727/3a3a\u001b\\${DA1_REPLY}`);

    await expect(pending).resolves.toBe('#24273a');
    expect(terminal.written()).toBe(`${OSC_11_QUERY}${DA1_QUERY}`);
  });

  it('stops at the device-attributes reply when the terminal does not answer the colour query', async () => {
    const terminal = fakeTerminal();
    const started = Date.now();
    const pending = queryTerminalBackground(terminal.input, terminal.output, 5_000);
    terminal.reply(DA1_REPLY);

    await expect(pending).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('gives up after the timeout when nothing answers', async () => {
    const terminal = fakeTerminal();

    await expect(
      queryTerminalBackground(terminal.input, terminal.output, 20),
    ).resolves.toBeUndefined();
  });

  it('restores the raw mode it found and leaves no listener behind', async () => {
    const terminal = fakeTerminal();
    const pending = queryTerminalBackground(terminal.input, terminal.output, 1_000);
    terminal.reply(`\u001b]11;rgb:ffff/ffff/ffff\u0007${DA1_REPLY}`);
    await pending;

    expect(terminal.rawModes).toEqual([true, false]);
    expect(terminal.input.listenerCount('data')).toBe(0);
  });
});
