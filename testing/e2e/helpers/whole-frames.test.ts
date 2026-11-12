import XtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moveCursorTo } from './move-cursor.js';
import { wholeFrames } from './whole-frames.js';

const START = '\x1b[?2026h';
const END = '\x1b[?2026l';
const CLEAR = '\x1b[2J\x1b[3J\x1b[H';
const BODY = `${CLEAR}${Array.from({ length: 12 }, (_, row) => `row ${row}`).join('\r\n')}`;
const FRAME = `${START}${BODY}${END}`;

/** Cuts `text` into `pieces` chunks of near-equal length, the way the pty hands a frame over. */
function cut(text: string, pieces: number): string[] {
  const size = Math.ceil(text.length / pieces);
  return Array.from({ length: pieces }, (_, index) => text.slice(index * size, (index + 1) * size));
}

function recordedFeed() {
  const calls: string[] = [];
  return { calls, ...wholeFrames((data) => calls.push(data)) };
}

describe('wholeFrames', () => {
  it.for([3, 9])('holds a frame cut into %i chunks until its end marker arrives', (pieces) => {
    const { calls, feed } = recordedFeed();
    const chunks = cut(FRAME, pieces);
    chunks.forEach((chunk, index) => {
      feed(chunk);
      expect(calls).toEqual(index === chunks.length - 1 ? [FRAME] : []);
    });
  });

  it('passes data outside a frame at once and gives whole frames wherever a marker sits', () => {
    const { calls, feed } = recordedFeed();
    feed('\x1b[?1049h');
    expect(calls).toEqual(['\x1b[?1049h']);

    feed(START);
    feed(BODY);
    expect(calls).toHaveLength(1);
    feed(END);
    expect(calls).toEqual(['\x1b[?1049h', FRAME]);

    feed(`boot${START}${BODY}`);
    expect(calls).toEqual(['\x1b[?1049h', FRAME, 'boot']);
    feed(`${END}after`);
    expect(calls).toEqual(['\x1b[?1049h', FRAME, 'boot', `${FRAME}after`]);

    feed(`${FRAME}${FRAME}`);
    expect(calls).toEqual(['\x1b[?1049h', FRAME, 'boot', `${FRAME}after`, `${FRAME}${FRAME}`]);
  });

  it.for(Array.from({ length: START.length - 1 }, (_, index) => index + 1))(
    'joins the start and the end marker when the pty splits them after byte %i',
    (at) => {
      const { calls, feed } = recordedFeed();
      feed(`boot${START.slice(0, at)}`);
      expect(calls).toEqual(['boot']);
      feed(`${START.slice(at)}${BODY}${END.slice(0, at)}`);
      expect(calls).toEqual(['boot']);
      feed(END.slice(at));
      expect(calls).toEqual(['boot', FRAME]);
    },
  );

  it('gives an open frame and a held marker tail to the sink on flush', () => {
    const { calls, feed, flush } = recordedFeed();
    feed(`${START}${BODY}`);
    expect(calls).toEqual([]);
    flush();
    expect(calls).toEqual([`${START}${BODY}`]);
    flush();
    expect(calls).toEqual([`${START}${BODY}`]);

    feed(`exit${START.slice(0, 5)}`);
    flush();
    expect(calls).toEqual([`${START}${BODY}`, 'exit', START.slice(0, 5)]);
  });
});

describe('moveCursorTo on a pty that hands each frame over in chunks', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const ROWS = ['+ Add custom model…', 'auto', 'DeepSeek V4.1 Flash'];
  const pickerFrame = (cursor: number) =>
    `${START}${CLEAR}${ROWS.map((row, index) => `${index === cursor ? '▌' : ' '} ${row}`).join('\r\n')}${END}`;

  /**
   * Moves a scripted picker's cursor from its last row to its first. Each `↑` answers with the
   * next frame in 9 chunks, and one chunk reaches the terminal before each read of the screen.
   */
  async function pressesToTop(
    feedOf: (terminal: XtermHeadless.Terminal) => (chunk: string) => void,
  ): Promise<number> {
    vi.useFakeTimers();
    const terminal = new XtermHeadless.Terminal({
      cols: 40,
      rows: ROWS.length,
      allowProposedApi: true,
      logLevel: 'off',
    });
    const feed = feedOf(terminal);
    let cursor = ROWS.length - 1;
    const pending = [pickerFrame(cursor)];
    let presses = 0;
    const text = () => {
      const chunk = pending.shift();
      if (chunk !== undefined) feed(chunk);
      vi.runAllTimers();
      return ROWS.map(
        (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
      ).join('\n');
    };
    const write = () => {
      presses++;
      cursor = Math.max(0, cursor - 1);
      pending.push(...cut(pickerFrame(cursor), 9));
    };
    try {
      await moveCursorTo(text, write, '\x1b[A', /▌ \+ Add custom model…/);
    } finally {
      terminal.dispose();
    }
    return presses;
  }

  it('presses once per row through wholeFrames, where a chunk-by-chunk feed presses past', async () => {
    expect(await pressesToTop((terminal) => wholeFrames((data) => terminal.write(data)).feed)).toBe(
      2,
    );
    expect(await pressesToTop((terminal) => (chunk) => terminal.write(chunk))).toBeGreaterThan(2);
  });
});
