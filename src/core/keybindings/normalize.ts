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

export function normalizeKeySignature({ input, key }: NormalizeKeyInput): NormalizedKeySignature {
  const normalizedKey = keyName(input, key);

  return {
    input,
    key: normalizedKey,
    ctrl: key.ctrl === true,
    shift: key.shift === true,
    alt: key.meta === true,
    super: key.super === true,
    hyper: key.hyper === true,
  };
}
