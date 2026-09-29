import type { Key } from 'ink';

function isTerminalControl(char: string): boolean {
  const code = char.codePointAt(0);
  return code !== undefined && (code < 0x20 || code === 0x7f);
}

// A late read hands Ink every byte it collected as one input, so two chords can arrive as one
// `\x03\x03` chunk. A run of control bytes is keys, never text, however many of them there are.
export function isTerminalControlRun(input: string): boolean {
  return input.length > 0 && input.split('').every(isTerminalControl);
}

export function isTextEntryInput(input: string, key: Key): boolean {
  if (input.length === 0 || key.ctrl || key.meta || key.super || key.hyper) return false;
  if (
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageUp ||
    key.pageDown ||
    key.home ||
    key.end ||
    key.return ||
    key.tab ||
    key.escape ||
    key.backspace ||
    key.delete
  ) {
    return false;
  }
  return !isTerminalControlRun(input);
}

export function isUnmodifiedYInput(input: string, key: Key): boolean {
  return input === 'y' && !key.shift && isTextEntryInput(input, key);
}
