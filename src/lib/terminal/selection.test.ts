import { PassThrough } from 'node:stream';
import XtermHeadless from '@xterm/headless';
import UnicodeGraphemes from '@xterm/addon-unicode-graphemes';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CopyOutcome } from '../clipboard/clipboard.js';
import type { MouseEvent } from './filtered-stdin/types.js';
import { installTerminalSelection } from './selection.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function setup(copy = vi.fn<(text: string) => Promise<CopyOutcome>>().mockResolvedValue('native')) {
  const stdout = Object.assign(new PassThrough(), { columns: 24, rows: 4, isTTY: true });
  const visible = new XtermHeadless.Terminal({
    cols: stdout.columns,
    rows: stdout.rows,
    scrollback: 0,
    allowProposedApi: true,
    convertEol: true,
  });
  visible.loadAddon(new UnicodeGraphemes.UnicodeGraphemesAddon());
  stdout.on('data', (data: Buffer) => visible.write(data));
  const originalWrite = stdout.write;
  const reportError = vi.fn();
  const onCopyKey = vi.fn();
  const selection = installTerminalSelection({
    stdout: stdout as unknown as NodeJS.WriteStream,
    copy,
    reportError,
    onCopyKey,
  });
  const dispatch = vi.fn();
  let frame = '';
  const repaint = () => stdout.write(`\u001b[2J\u001b[H${frame}`);
  stdout.on('resize', repaint);
  const render = (text: string) => {
    frame = text;
    repaint();
  };
  const mouse = (type: MouseEvent['type'], x: number, y = 1, button = 0) => {
    selection.handleMouse({ type, x, y, button, shift: false, ctrl: false, meta: false }, dispatch);
  };
  const line = (y = 0) => visible.buffer.active.getLine(y)?.translateToString(true);
  const inverse = (x: number, y = 0) =>
    Boolean(visible.buffer.active.getLine(y)?.getCell(x)?.isInverse());
  const settle = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    await new Promise<void>((resolve) => visible.write('', resolve));
  };
  cleanup.push(() => {
    selection.dispose();
    stdout.destroy();
    visible.dispose();
  });
  return {
    stdout,
    visible,
    originalWrite,
    selection,
    reportError,
    onCopyKey,
    copy,
    dispatch,
    render,
    mouse,
    line,
    inverse,
    settle,
  };
}

describe('fullscreen terminal selection', () => {
  it('mirrors Ink LF rows at their physical TTY columns', async () => {
    const h = setup();
    h.render('a full-width header row!\n  COPY-ME-ASCII\nfooter');
    await h.settle();
    h.mouse('press', 3, 2);
    h.mouse('move', 15, 2);
    await h.settle();
    expect(h.line(1)).toBe('  COPY-ME-ASCII');
    expect(h.inverse(2, 1)).toBe(true);
    h.mouse('release', 15, 2);
    await h.settle();
    expect(h.copy).toHaveBeenCalledWith('COPY-ME-ASCII');
  });
  it('freezes during drag, copies its snapshot, and immediately shows changed output on release', async () => {
    const h = setup();
    h.render('original text');
    await h.settle();
    h.mouse('press', 1);
    h.mouse('move', 8);
    h.render('updated text');
    await h.settle();
    expect(h.line()).toBe('original text');
    expect(h.inverse(0)).toBe(true);
    h.mouse('release', 8);
    await h.settle();
    expect(h.copy).toHaveBeenCalledWith('original');
    expect(h.line()).toBe('updated text');
    expect(h.inverse(0)).toBe(false);
    h.render('another update');
    await h.settle();
    expect(h.line()).toBe('another update');
    expect(h.selection.filterInput('\u0003')).toBe('\u0003');
  });

  it('retains a completed highlight across updates elsewhere without freezing the display', async () => {
    const h = setup();
    h.render('selected\r\nfirst status');
    await h.settle();
    h.mouse('press', 1);
    h.mouse('move', 8);
    h.mouse('release', 8);
    await h.settle();
    expect(h.inverse(0)).toBe(true);
    h.render('selected\r\nsecond status');
    await h.settle();
    expect(h.line(1)).toBe('second status');
    expect(h.inverse(0)).toBe(true);
    expect(h.selection.filterInput('\u0003')).toBe('');
    await h.settle();
    expect(h.copy).toHaveBeenCalledTimes(2);
  });

  it('never exposes a clean clock repaint without the retained selection highlight', async () => {
    const h = setup();
    h.render('selected\nstatus 1');
    await h.settle();
    h.mouse('press', 1);
    h.mouse('move', 8);
    h.mouse('release', 8);
    await h.settle();
    const visibleFrames: boolean[] = [];
    h.stdout.on('data', () => {
      h.visible.write('', () => visibleFrames.push(h.inverse(0)));
    });
    h.render('selected\nstatus 2');
    await h.settle();
    expect(h.line(1)).toBe('status 2');
    expect(visibleFrames.length).toBeGreaterThan(0);
    expect(visibleFrames.every(Boolean)).toBe(true);
  });

  it('includes the retained highlight before Ink ends its synchronized repaint', async () => {
    const h = setup();
    h.render('selected\nstatus 1');
    await h.settle();
    h.mouse('press', 1);
    h.mouse('move', 8);
    h.mouse('release', 8);
    await h.settle();
    const committedFrames: boolean[] = [];
    h.visible.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (params.includes(2026)) committedFrames.push(h.inverse(0));
      return false;
    });
    h.stdout.write('\u001b[?2026h');
    h.render('selected\nstatus 2');
    h.stdout.write('\u001b[?2026l');
    h.stdout.write('\u001b[?2026h');
    h.render('selected\nstatus 3');
    h.stdout.write('\u001b[?2026l');
    await h.settle();
    expect(h.line(1)).toBe('status 3');
    expect(committedFrames).toEqual([true]);
  });

  it('copies the same Unicode range backward, including CJK, ZWJ and combining marks', async () => {
    const h = setup();
    h.render('A界👩‍💻e\u0301Z');
    await h.settle();
    h.mouse('press', 6);
    h.mouse('move', 3);
    h.mouse('release', 3);
    await h.settle();
    expect(h.copy).toHaveBeenCalledWith('界👩‍💻e\u0301');
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches clicks only on release and resumes output when a press does not drag', async () => {
    const h = setup();
    h.render('first');
    await h.settle();
    h.mouse('press', 2);
    expect(h.dispatch).not.toHaveBeenCalled();
    h.render('second');
    h.mouse('release', 2);
    await h.settle();
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: 'press', x: 2 }),
    );
    expect(h.copy).not.toHaveBeenCalled();
    expect(h.line()).toBe('second');
  });

  it.each([
    '\u0003',
    '\u001b[99;5u',
    '\u001b[99;9u',
    '\u001b[99;9:1u',
    '\u001b[99;9:2u',
    '\u001b[99;73u',
    '\u001b[99;133u',
  ])(
    'copies through delivered shortcut %j and leaves it untouched without a selection',
    async (key) => {
      const h = setup();
      expect(h.selection.filterInput(key)).toBe(key);
      h.render('copy me');
      await h.settle();
      h.mouse('press', 1);
      h.mouse('move', 4);
      h.mouse('release', 4);
      await h.settle();
      expect(h.selection.filterInput(key)).toBe('');
      await h.settle();
      expect(h.copy).toHaveBeenNthCalledWith(2, 'copy');
    },
  );

  it('ignores key release for selection state but clears on typing, arrows and Escape', async () => {
    const h = setup();
    h.render('keep selected');
    await h.settle();
    const select = async () => {
      h.mouse('press', 1);
      h.mouse('move', 4);
      h.mouse('release', 4);
      await h.settle();
    };
    await select();
    expect(h.selection.filterInput('\u001b[99;9:3u')).toBe('\u001b[99;9:3u');
    await h.settle();
    expect(h.inverse(0)).toBe(true);
    expect(h.copy).toHaveBeenCalledTimes(1);
    expect(h.selection.filterInput('\u001b[A')).toBe('\u001b[A');
    await h.settle();
    expect(h.inverse(0)).toBe(false);
    await select();
    expect(h.selection.filterInput('a')).toBe('a');
    await h.settle();
    expect(h.inverse(0)).toBe(false);
    await select();
    expect(h.selection.filterInput('\u001b')).toBe('');
    expect(h.selection.filterInput('\u0003')).toBe('\u0003');
    await select();
    expect(h.selection.filterInput('\u001b[27u')).toBe('');
    expect(h.selection.filterInput('\u0003')).toBe('\u0003');
  });

  it('consumes a copy shortcut coalesced with subsequent typing without forwarding interrupt', async () => {
    const h = setup();
    h.render('copy');
    await h.settle();
    h.mouse('press', 1);
    h.mouse('move', 4);
    h.mouse('release', 4);
    await h.settle();
    expect(h.selection.filterInput('\u0003x')).toBe('x');
    await h.settle();
    expect(h.copy).toHaveBeenCalledTimes(2);
    expect(h.inverse(0)).toBe(false);
    expect(h.selection.filterInput('\u0003')).toBe('\u0003');
  });

  it.each(['\x03', '\x1b[99;5u'])(
    'spends one %j on copying and clears the highlight',
    async (key) => {
      const h = setup();
      h.render('copy');
      await h.settle();
      h.mouse('press', 1);
      h.mouse('move', 4);
      h.mouse('release', 4);
      await h.settle();
      expect(h.selection.filterInput(key)).toBe('');
      await h.settle();
      expect(h.inverse(0)).toBe(false);
      expect(h.onCopyKey).toHaveBeenCalledTimes(1);
      await expect(h.onCopyKey.mock.calls[0]?.[0]).resolves.toBe('native');
      expect(h.copy).toHaveBeenLastCalledWith('copy');
      expect(h.selection.filterInput(key)).toBe(key);
    },
  );

  it.each(['\x03\x03', '\x03\x03\x03'])('consumes only one Ctrl+C from %j', async (chunk) => {
    const h = setup();
    h.render('copy');
    await h.settle();
    h.mouse('press', 1);
    h.mouse('move', 4);
    h.mouse('release', 4);
    await h.settle();
    expect(h.selection.filterInput(chunk)).toBe(chunk.slice(1));
    await h.settle();
    expect(h.copy).toHaveBeenCalledTimes(2);
    expect(h.inverse(0)).toBe(false);
  });

  it('keeps the selection for Super+C, then spends Ctrl+C only once', async () => {
    const h = setup();
    h.render('copy');
    await h.settle();
    h.mouse('press', 1);
    h.mouse('move', 4);
    h.mouse('release', 4);
    await h.settle();
    expect(h.selection.filterInput('\x1b[99;9u')).toBe('');
    await h.settle();
    expect(h.inverse(0)).toBe(true);
    expect(h.selection.filterInput('\x03')).toBe('');
    await h.settle();
    expect(h.inverse(0)).toBe(false);
    expect(h.copy).toHaveBeenCalledTimes(3);
    expect(h.selection.filterInput('\x03')).toBe('\x03');
  });

  it('keeps wheel dispatch and cancels selection on resize or lost mouse release', async () => {
    const h = setup();
    h.render('scrollable');
    await h.settle();
    h.mouse('press', 1);
    h.mouse('move', 5);
    h.mouse('wheel-down', 5, 1, 65);
    await h.settle();
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'wheel-down' }));
    expect(h.inverse(0)).toBe(false);
    h.mouse('press', 1);
    h.mouse('move', 5);
    h.stdout.emit('resize');
    await h.settle();
    expect(h.inverse(0)).toBe(false);
    h.mouse('press', 1);
    h.mouse('move', 5);
    h.render('new output');
    h.mouse('move', 5, 1, 3);
    await h.settle();
    expect(h.line()).toBe('new output');
  });

  it('passes editor output while suspended and restores selection after resume', async () => {
    const h = setup();
    h.render('before');
    await h.settle();
    h.mouse('press', 1);
    h.mouse('move', 3);
    h.selection.suspend();
    h.render('editor');
    await h.settle();
    expect(h.line()).toBe('editor');
    h.selection.resume();
    h.render('resumed');
    await h.settle();
    h.mouse('press', 1);
    h.mouse('move', 3);
    h.mouse('release', 3);
    await h.settle();
    expect(h.copy).toHaveBeenCalledWith('res');
  });

  it('does not swallow alternate-buffer exit split across writes during a drag', async () => {
    const h = setup();
    h.stdout.write('\u001b[?1049h');
    h.render('alternate');
    await h.settle();
    h.mouse('press', 1);
    h.mouse('move', 4);
    h.stdout.write('\u001b[?104');
    h.stdout.write('9l');
    await h.settle();
    expect(h.visible.buffer.active.type).toBe('normal');
    expect(h.copy).not.toHaveBeenCalled();
    h.stdout.write('restored');
    await h.settle();
    expect(h.line()).toBe('restored');
  });

  it('resumes immediately even with an old alternate-buffer exit still awaiting parsing', async () => {
    const h = setup();
    h.stdout.write('\u001b[?1049h');
    h.render('old content');
    h.stdout.write('\u001b[?1049l');
    h.selection.suspend();
    h.selection.resume();
    h.stdout.write('\u001b[?1049h');
    h.render('new content');
    await h.settle();
    h.mouse('press', 1);
    h.mouse('move', 3);
    h.mouse('release', 3);
    await h.settle();
    expect(h.copy).toHaveBeenCalledWith('new');
    expect(h.inverse(0)).toBe(true);
    expect(h.visible.buffer.active.type).toBe('alternate');
  });

  it('restores stdout and listeners on idempotent disposal and suppresses pending copy', async () => {
    const warning = vi.spyOn(console, 'warn');
    const h = setup();
    h.render('selected');
    await h.settle();
    h.mouse('press', 1);
    h.mouse('move', 4);
    h.mouse('release', 4);
    h.selection.dispose();
    h.selection.dispose();
    expect(h.stdout.write).toBe(h.originalWrite);
    expect(h.stdout.listenerCount('resize')).toBe(1);
    h.render('after dispose');
    await h.settle();
    expect(h.line()).toBe('after dispose');
    expect(h.copy).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('serializes clipboard writes and reports unavailable delivery', async () => {
    let finish: ((value: CopyOutcome) => void) | undefined;
    const copy = vi
      .fn<(text: string) => Promise<CopyOutcome>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue('unavailable');
    const h = setup(copy);
    h.render('copy');
    await h.settle();
    h.mouse('press', 1);
    h.mouse('move', 4);
    h.mouse('release', 4);
    await h.settle();
    h.selection.filterInput('\u0003');
    await h.settle();
    expect(copy).toHaveBeenCalledTimes(1);
    finish?.('native');
    await h.settle();
    expect(copy).toHaveBeenCalledTimes(2);
    await expect(h.onCopyKey.mock.calls[0]?.[0]).resolves.toBe('unavailable');
  });
});
