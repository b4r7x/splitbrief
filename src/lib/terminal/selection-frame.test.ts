import XtermHeadless from '@xterm/headless';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { afterEach, describe, expect, it } from 'vitest';
import { renderSelection, selectionText, snapshotTerminalFrame } from './selection-frame.js';

const terminals: XtermHeadless.Terminal[] = [];

async function terminalWith(text: string, cols = 12, rows = 4) {
  const terminal = new XtermHeadless.Terminal({
    cols,
    rows,
    scrollback: 0,
    allowProposedApi: true,
    logLevel: 'off',
  });
  terminal.loadAddon(new UnicodeGraphemesAddon());
  terminals.push(terminal);
  await write(terminal, text);
  return terminal;
}

function write(terminal: XtermHeadless.Terminal, text: string): Promise<void> {
  return new Promise((resolve) => terminal.write(text, resolve));
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

describe('terminal selection frame', () => {
  it('copies the same inclusive partial range in both drag directions', async () => {
    const terminal = await terminalWith('hello world');
    const frame = snapshotTerminalFrame(terminal);
    expect(selectionText(frame, { x: 1, y: 0 }, { x: 4, y: 0 })).toBe('ello');
    expect(selectionText(frame, { x: 4, y: 0 }, { x: 1, y: 0 })).toBe('ello');
  });

  it('trims terminal padding while preserving blank rows and source indentation', async () => {
    const terminal = await terminalWith('\r\n  first\r\n\r\n  last');
    const frame = snapshotTerminalFrame(terminal);
    expect(selectionText(frame, { x: 0, y: 0 }, { x: 11, y: 3 })).toBe('\n  first\n\n  last');
    expect(selectionText(frame, { x: 2, y: 1 }, { x: 3, y: 3 })).toBe('first\n\n  la');
  });

  it('joins soft-wrapped rows and preserves written spaces across the wrap', async () => {
    const terminal = await terminalWith('abcd  efgh\r\nnext', 6, 4);
    const frame = snapshotTerminalFrame(terminal);
    expect(selectionText(frame, { x: 0, y: 0 }, { x: 5, y: 2 })).toBe('abcd  efgh\nnext');
  });

  it('includes complete CJK, emoji and combining characters at either endpoint', async () => {
    const terminal = await terminalWith('A界😀e\u0301Z');
    const frame = snapshotTerminalFrame(terminal);
    expect(selectionText(frame, { x: 2, y: 0 }, { x: 5, y: 0 })).toBe('界😀e\u0301');
    expect(selectionText(frame, { x: 5, y: 0 }, { x: 2, y: 0 })).toBe('界😀e\u0301');
    expect(selectionText(frame, { x: 1, y: 0 }, { x: 1, y: 0 })).toBe('界');
    expect(selectionText(frame, { x: 4, y: 0 }, { x: 4, y: 0 })).toBe('😀');
    await write(terminal, renderSelection(frame, { x: 2, y: 0 }, { x: 3, y: 0 }));
    const line = terminal.buffer.active.getLine(0);
    expect(line?.translateToString(true)).toBe('A界😀e\u0301Z');
    expect(line?.getCell(0)?.isInverse()).toBe(0);
    expect(line?.getCell(1)?.isInverse()).not.toBe(0);
    expect(line?.getCell(3)?.isInverse()).not.toBe(0);
    expect(line?.getCell(5)?.isInverse()).toBe(0);
  });

  it('copies and highlights a whole ZWJ emoji when dragging only its continuation cell', async () => {
    const terminal = await terminalWith('X👩‍💻Y');
    const frame = snapshotTerminalFrame(terminal);
    expect(selectionText(frame, { x: 2, y: 0 }, { x: 2, y: 0 })).toBe('👩‍💻');
    await write(terminal, renderSelection(frame, { x: 2, y: 0 }, { x: 2, y: 0 }));
    const line = terminal.buffer.active.getLine(0);
    expect(line?.translateToString(true)).toBe('X👩‍💻Y');
    expect(line?.getCell(0)?.isInverse()).toBe(0);
    expect(line?.getCell(1)?.isInverse()).not.toBe(0);
    expect(line?.getCell(1)?.getWidth()).toBe(2);
    expect(line?.getCell(3)?.isInverse()).toBe(0);
  });

  it('retains snapshot text after later writes mutate the terminal', async () => {
    const terminal = await terminalWith('before');
    const frame = snapshotTerminalFrame(terminal);
    await write(terminal, '\rAFTER!');
    expect(selectionText(frame, { x: 0, y: 0 }, { x: 5, y: 0 })).toBe('before');
  });

  it('preserves cell colors and attributes while toggling inverse only inside the range', async () => {
    const terminal = await terminalWith('\u001b[1;3;4;38;2;12;34;56;48;5;22mABC\u001b[7mD');
    const frame = snapshotTerminalFrame(terminal);
    await write(terminal, renderSelection(frame, { x: 1, y: 0 }, { x: 3, y: 0 }));
    const line = terminal.buffer.active.getLine(0);
    expect(line?.getCell(0)?.isInverse()).toBe(0);
    const selected = line?.getCell(1);
    expect(selected?.isInverse()).not.toBe(0);
    expect(selected?.isBold()).not.toBe(0);
    expect(selected?.isItalic()).not.toBe(0);
    expect(selected?.isUnderline()).not.toBe(0);
    expect(selected?.getFgColor()).toBe(0x0c2238);
    expect(selected?.getBgColor()).toBe(22);
    expect(line?.getCell(3)?.isInverse()).toBe(0);
  });

  it('highlights through the bottom-right cell without scrolling or moving the cursor', async () => {
    const terminal = await terminalWith('abcde\r\nfghij\r\nklmno\u001b[2;3H', 5, 3);
    const frame = snapshotTerminalFrame(terminal);
    const output = renderSelection(frame, { x: 3, y: 0 }, { x: 4, y: 2 });
    expect(output).not.toContain('\n');
    await write(terminal, output);
    const buffer = terminal.buffer.active;
    expect([buffer.cursorX, buffer.cursorY]).toEqual([2, 1]);
    expect(buffer.getLine(0)?.translateToString()).toBe('abcde');
    expect(buffer.getLine(1)?.translateToString()).toBe('fghij');
    expect(buffer.getLine(2)?.translateToString()).toBe('klmno');
    expect(buffer.getLine(0)?.getCell(2)?.isInverse()).toBe(0);
    expect(buffer.getLine(0)?.getCell(3)?.isInverse()).not.toBe(0);
    expect(buffer.getLine(2)?.getCell(4)?.isInverse()).not.toBe(0);
  });

  it('clips an out-of-screen drag to the visible viewport', async () => {
    const terminal = await terminalWith('first\r\nlast', 6, 2);
    const frame = snapshotTerminalFrame(terminal);
    expect(selectionText(frame, { x: -3, y: -1 }, { x: 50, y: 10 })).toBe('first\nlast');
  });

  it('restores original colors and inverse when a drag shrinks then reverses', async () => {
    const terminal = await terminalWith('\u001b[31mabc\u001b[7mdef');
    const frame = snapshotTerminalFrame(terminal);
    const anchor = { x: 2, y: 0 };
    const end = { x: 5, y: 0 };
    await write(terminal, renderSelection(frame, anchor, end));
    await write(terminal, renderSelection(frame, anchor, { x: 0, y: 0 }, { anchor, focus: end }));
    const line = terminal.buffer.active.getLine(0);
    expect(line?.translateToString(true)).toBe('abcdef');
    expect(line?.getCell(0)?.isInverse()).not.toBe(0);
    expect(line?.getCell(1)?.isInverse()).not.toBe(0);
    expect(line?.getCell(2)?.isInverse()).not.toBe(0);
    expect(line?.getCell(3)?.isInverse()).not.toBe(0);
    expect(line?.getCell(5)?.isInverse()).not.toBe(0);
    expect(line?.getCell(5)?.getFgColor()).toBe(1);
  });
});
