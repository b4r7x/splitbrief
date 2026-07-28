import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';
import { isLoneTerminalControl, isTextEntryInput, isUnmodifiedYInput } from './text-entry.js';

const BASE_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

function key(overrides: Partial<Key> = {}): Key {
  return { ...BASE_KEY, ...overrides };
}

describe('isLoneTerminalControl', () => {
  it.each([
    { name: 'empty input', input: '', expected: false },
    { name: 'plain text', input: 'a', expected: false },
    { name: 'pasted text', input: 'alpha beta', expected: false },
    { name: 'emoji', input: '💡', expected: false },
    { name: 'NUL', input: '\x00', expected: true },
    { name: 'unit separator', input: '\x1f', expected: true },
    { name: 'DEL', input: '\x7f', expected: true },
  ])('classifies $name', ({ input, expected }) => {
    expect(isLoneTerminalControl(input)).toBe(expected);
  });
});

describe('isTextEntryInput', () => {
  it.each([
    { name: 'empty input', input: '', expected: false, key: {} },
    { name: 'plain text', input: 'a', expected: true, key: {} },
    { name: 'pasted text', input: 'alpha beta', expected: true, key: {} },
    { name: 'Unicode text', input: 'zażółć 💡', expected: true, key: {} },
    { name: 'shifted text', input: 'A', expected: true, key: { shift: true } },
    { name: 'NUL', input: '\x00', expected: false, key: {} },
    { name: 'DEL', input: '\x7f', expected: false, key: {} },
  ])('classifies $name', ({ input, expected, key: keyOverrides }) => {
    expect(isTextEntryInput(input, key(keyOverrides))).toBe(expected);
  });

  it.each([
    { name: 'ctrl', key: { ctrl: true } },
    { name: 'meta', key: { meta: true } },
    { name: 'super', key: { super: true } },
    { name: 'hyper', key: { hyper: true } },
  ])('rejects the $name modifier', ({ key: keyOverrides }) => {
    expect(isTextEntryInput('a', key(keyOverrides))).toBe(false);
  });

  it.each([
    { name: 'up arrow', key: { upArrow: true } },
    { name: 'down arrow', key: { downArrow: true } },
    { name: 'left arrow', key: { leftArrow: true } },
    { name: 'right arrow', key: { rightArrow: true } },
    { name: 'page up', key: { pageUp: true } },
    { name: 'page down', key: { pageDown: true } },
    { name: 'home', key: { home: true } },
    { name: 'end', key: { end: true } },
    { name: 'return', key: { return: true } },
    { name: 'tab', key: { tab: true } },
    { name: 'escape', key: { escape: true } },
    { name: 'backspace', key: { backspace: true } },
    { name: 'delete', key: { delete: true } },
  ])('rejects the $name key', ({ key: keyOverrides }) => {
    expect(isTextEntryInput('a', key(keyOverrides))).toBe(false);
  });
});

describe('isUnmodifiedYInput', () => {
  it.each([
    { name: 'lowercase y', input: 'y', key: {}, expected: true },
    { name: 'uppercase Y', input: 'Y', key: {}, expected: false },
    { name: 'Shift+y', input: 'y', key: { shift: true }, expected: false },
    { name: 'Ctrl+y', input: 'y', key: { ctrl: true }, expected: false },
    { name: 'Meta+y', input: 'y', key: { meta: true }, expected: false },
    { name: 'Super+y', input: 'y', key: { super: true }, expected: false },
    { name: 'Hyper+y', input: 'y', key: { hyper: true }, expected: false },
  ])('classifies $name', ({ input, key: keyOverrides, expected }) => {
    expect(isUnmodifiedYInput(input, key(keyOverrides))).toBe(expected);
  });
});
