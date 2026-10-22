import { afterEach, expect, it, vi } from 'vitest';
import { terminalSequences } from '../../lib/terminal/control.js';
import { createEditorOutput } from './editor-output.js';

afterEach(() => vi.restoreAllMocks());

it('holds back TUI frames during editor handover without holding back editor output', () => {
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  const output = createEditorOutput(process.stdout);
  output.stdout.write('TUI before');
  output.suspend();
  const flushed = vi.fn();
  expect(output.stdout.write('queued TUI frame', flushed)).toBe(true);
  expect(flushed).toHaveBeenCalled();
  process.stdout.write('editor return instruction');
  output.resume();
  output.stdout.write('TUI after', 'utf8');
  expect(written).toEqual(['TUI before', 'editor return instruction', 'TUI after']);
});

it('lets only the keyboard-mode pop through once closed, and nothing when an editor holds the terminal', () => {
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  const closed = createEditorOutput(process.stdout);
  closed.close();
  closed.stdout.write('final frame');
  closed.stdout.write(terminalSequences.popKittyKeyboard);
  const handedOver = createEditorOutput(process.stdout);
  handedOver.suspend();
  handedOver.close();
  handedOver.stdout.write(terminalSequences.popKittyKeyboard);
  expect(written).toEqual([terminalSequences.popKittyKeyboard]);
});

it('remembers the keyboard mode Ink pushed until Ink pops it', () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const output = createEditorOutput(process.stdout);
  expect(output.keyboardPush()).toBeUndefined();
  output.stdout.write('\u001b[>1u');
  expect(output.keyboardPush()).toBe('\u001b[>1u');
  output.stdout.write('frame');
  expect(output.keyboardPush()).toBe('\u001b[>1u');
  output.stdout.write(terminalSequences.popKittyKeyboard);
  expect(output.keyboardPush()).toBeUndefined();
});

it('keeps resize events on the source terminal while Ink uses the wrapped output', () => {
  const output = createEditorOutput(process.stdout);
  const resized = vi.fn();
  output.stdout.on('resize', resized);
  try {
    process.stdout.emit('resize');
    expect(resized).toHaveBeenCalledOnce();
  } finally {
    output.stdout.off('resize', resized);
  }
});
