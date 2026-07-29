import type { Key } from 'ink';

export function isLoneTerminalControl(input: string): boolean {
  if (input.length !== 1) return false;
  const code = input.codePointAt(0);
  return code !== undefined && (code < 0x20 || code === 0x7f);
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
  return !isLoneTerminalControl(input);
}

export function isUnmodifiedYInput(input: string, key: Key): boolean {
  return input === 'y' && !key.shift && isTextEntryInput(input, key);
}
