import { glyph } from '../../lib/glyphs.js';

export interface KeyLike {
  upArrow?: boolean | undefined;
  downArrow?: boolean | undefined;
  leftArrow?: boolean | undefined;
  rightArrow?: boolean | undefined;
  pageUp?: boolean | undefined;
  pageDown?: boolean | undefined;
  home?: boolean | undefined;
  end?: boolean | undefined;
  return?: boolean | undefined;
  escape?: boolean | undefined;
  tab?: boolean | undefined;
  backspace?: boolean | undefined;
  delete?: boolean | undefined;
  ctrl?: boolean | undefined;
  shift?: boolean | undefined;
  meta?: boolean | undefined;
  super?: boolean | undefined;
  hyper?: boolean | undefined;
}

export interface NormalizeKeyInput {
  input: string;
  key: KeyLike;
}

export interface NormalizedKeySignature {
  input: string;
  key: string;
  display: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  super: boolean;
  hyper: boolean;
}

function keyName(input: string, key: KeyLike): string {
  if (key.upArrow) return 'arrow-up';
  if (key.downArrow) return 'arrow-down';
  if (key.leftArrow) return 'arrow-left';
  if (key.rightArrow) return 'arrow-right';
  if (key.pageUp) return 'page-up';
  if (key.pageDown) return 'page-down';
  if (key.home) return 'home';
  if (key.end) return 'end';
  if (key.return) return 'enter';
  if (key.escape) return 'escape';
  if (key.tab) return 'tab';
  if (key.backspace) return 'backspace';
  if (key.delete) return 'delete';
  if (input === '\x1f') return '/';
  if (input.length === 1) return input.toLowerCase();
  if (input.length > 0) return input;
  return 'unknown';
}

function displayKey(name: string): string {
  switch (name) {
    case 'arrow-up':
      return '↑';
    case 'arrow-down':
      return '↓';
    case 'arrow-left':
      return '←';
    case 'arrow-right':
      return glyph('connectorHandoff');
    case 'page-up':
      return 'PgUp';
    case 'page-down':
      return 'PgDn';
    case 'home':
      return 'Home';
    case 'end':
      return 'End';
    case 'enter':
      return 'Enter';
    case 'escape':
      return 'Escape';
    case 'tab':
      return 'Tab';
    case 'backspace':
      return 'Backspace';
    case 'delete':
      return 'Delete';
    default:
      return name.length === 1 ? name.toUpperCase() : name;
  }
}

export function normalizeKeySignature({ input, key }: NormalizeKeyInput): NormalizedKeySignature {
  const normalizedKey = keyName(input, key);
  const modifiers: string[] = [];
  if (key.ctrl === true) modifiers.push('Ctrl');
  if (key.meta === true) modifiers.push('Alt');
  if (key.super === true) modifiers.push('Meta');
  if (key.hyper === true) modifiers.push('Hyper');
  if (key.shift === true) modifiers.push('Shift');
  modifiers.push(displayKey(normalizedKey));

  return {
    input,
    key: normalizedKey,
    display: modifiers.join('+'),
    ctrl: key.ctrl === true,
    shift: key.shift === true,
    alt: key.meta === true,
    super: key.super === true,
    hyper: key.hyper === true,
  };
}
