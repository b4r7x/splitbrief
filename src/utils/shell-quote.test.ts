import { describe, expect, it } from 'vitest';
import {
  formatDetachedAttachHint,
  formatShellArgv,
  shellCommandFromText,
  shellQuoteArg,
} from './shell-quote.js';

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

describe('formatShellArgv', () => {
  it('joins argv tokens with shell-safe quoting', () => {
    expect(formatShellArgv(['diptych', 'attach', 'sess-1', '--project', '/tmp/my project'])).toBe(
      "diptych attach sess-1 --project '/tmp/my project'",
    );
  });
});

describe('formatDetachedAttachHint', () => {
  it('uses --project instead of a brittle cd && chain', () => {
    expect(formatDetachedAttachHint('/tmp/my project', '2026-04-01-feature')).toBe(
      "diptych attach 2026-04-01-feature --project '/tmp/my project'",
    );
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
