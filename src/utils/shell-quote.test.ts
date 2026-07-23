import { describe, expect, it } from 'vitest';
import { shellCommandFromText, shellQuoteArg } from './shell-quote.js';

describe('shellQuoteArg', () => {
  it.each([
    ['plain', 'plain'],
    ['path/with/slashes', 'path/with/slashes'],
    ['has spaces', "'has spaces'"],
    ["has'quote", "'has'\\''quote'"],
    ['', "''"],
  ])('quotes %j as %j', (input, expected) => {
    expect(shellQuoteArg(input)).toBe(expected);
  });
});

describe('shellCommandFromText', () => {
  it.each([
    ['/bin/zsh -lc "sed -n \'1,260p\' CLAUDE.md"', "sed -n '1,260p' CLAUDE.md"],
    ["bash -lc 'npm run typecheck'", 'npm run typecheck'],
    ['prefix /bin/sh -lc "rg \\"runner_call_activity\\" src"', 'rg \\"runner_call_activity\\" src'],
    ['node -e "console.log(1)"', null],
    ['/bin/zsh -lc ', null],
  ])('extracts the user command from %s', (input, expected) => {
    expect(shellCommandFromText(input)).toBe(expected);
  });
});
