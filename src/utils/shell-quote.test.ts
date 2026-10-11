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
    [
      `/bin/zsh -lc "rg --files --hidden -g '"'!node_modules'"' -g '"'!.git'"' -g '"'!package-lock.json'"' -g '"'!yarn.lock'"' -g '"'!pnpm-lock.yaml'"'"`,
      "rg --files --hidden -g '!node_modules' -g '!.git' -g '!package-lock.json' -g '!yarn.lock' -g '!pnpm-lock.yaml'",
    ],
    [
      `/bin/zsh -lc "rg --files --hidden -g '"'!node_modules'"' -g '"'!.git'"'"`,
      "rg --files --hidden -g '!node_modules' -g '!.git'",
    ],
    [`/bin/bash -lc 'echo '"'"'hi there'"'"''`, "echo 'hi there'"],
    [
      String.raw`/bin/zsh -lc 'rg --files -g '\''!node_modules'\'' src'`,
      "rg --files -g '!node_modules' src",
    ],
    ['/bin/zsh -lc "sed -n \'1,260p\' CLAUDE.md"', "sed -n '1,260p' CLAUDE.md"],
    ["bash -lc 'npm run typecheck'", 'npm run typecheck'],
    ['/bin/zsh -lc "rg \\"runner_call_activity\\" src"', 'rg "runner_call_activity" src'],
    [String.raw`bash -lc "printf 'a\nb'"`, String.raw`printf 'a\nb'`],
    [String.raw`/bin/zsh -lc "echo \$HOME"`, 'echo $HOME'],
    ['bash -lc ls', 'ls'],
    [`/bin/zsh -lc "rg --files -g '"'!x`, `/bin/zsh -lc "rg --files -g '"'!x`],
    ['rg -n "foo" src', null],
    [`echo "run bash -lc 'x'"`, null],
    ['node -e "console.log(1)"', null],
    ['/bin/zsh -lc ', null],
    ['  /bin/sh -lc "echo ok"', 'echo ok'],
    [`prefix /bin/sh -lc "echo ok"`, null],
    ['sh -lc echo\\ hi ignored', 'echo hi'],
    ['bash -lc echo\\ ', 'echo '],
    ['bash -lc echo\\\t', 'echo\t'],
    ['zsh -lc pre"quoted "post ignored', 'prequoted post'],
    [String.raw`bash -lc 'echo \$HOME'`, String.raw`echo \$HOME`],
    [String.raw`bash -lc "echo \`hi\` \\ path"`, 'echo `hi` \\ path'],
    ['bash -lc "echo a\\\nb"', 'echo ab'],
    ["bash -lc '' ignored", null],
    ['bash -lc ""', null],
    ["bash -lc 'echo unfinished", "bash -lc 'echo unfinished"],
    ['bash -lc echo\\', 'bash -lc echo\\'],
    ['bash -lc "echo\\', 'bash -lc "echo\\'],
    ["  bash -lc 'echo unfinished  ", "bash -lc 'echo unfinished"],
    [String.raw`bash -lc $'echo hi\nls'`, String.raw`bash -lc $'echo hi\nls'`],
    ['bash -lc $"echo hi"', 'bash -lc $"echo hi"'],
    ["bash -lc 'echo ok' 'unfinished", "bash -lc 'echo ok' 'unfinished"],
    ["bash -lc 'echo ok' trailing\\", "bash -lc 'echo ok' trailing\\"],
    ["bash -lc 'echo ok' $'unsupported'", "bash -lc 'echo ok' $'unsupported'"],
    ['bash\t-lc\t"echo ok"', 'echo ok'],
    ["'bash' -lc 'echo ok'", 'echo ok'],
    ['bash -lc', null],
    ['sh -lc "echo a\\\nb"', 'echo ab'],
    ['sh -lc echo\\\nhi', 'echohi'],
  ])('extracts the user command from %s', (input, expected) => {
    expect(shellCommandFromText(input)).toBe(expected);
  });
});
