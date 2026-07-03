import { describe, expect, it } from 'vitest';
import { prettifyShellActivity, type PrettyShellActivity } from './shell-activity-pretty.js';

describe('prettifyShellActivity', () => {
  const hits: [string, PrettyShellActivity][] = [
    ["sed -n '1,240p' CLAUDE.md", { label: 'READ', value: 'CLAUDE.md :1-240' }],
    ['sed -n "12,40p" src/foo.ts', { label: 'READ', value: 'src/foo.ts :12-40' }],
    ['sed -n 5,10p README.md', { label: 'READ', value: 'README.md :5-10' }],
    ['cat package.json', { label: 'READ', value: 'package.json' }],
    ['cat -n src/x.ts', { label: 'READ', value: 'src/x.ts' }],
    ['head -n 40 src/index.ts', { label: 'READ', value: 'src/index.ts' }],
    ['head -50 notes.md', { label: 'READ', value: 'notes.md' }],
    ['tail -n 20 log.txt', { label: 'READ', value: 'log.txt' }],
    ['tail -n20 log.txt', { label: 'READ', value: 'log.txt' }],
    [
      'rg deriveLiveStatus src/features',
      { label: 'FIND', value: '"deriveLiveStatus"  src/features' },
    ],
    ['rg -n foo src', { label: 'FIND', value: '"foo"  src' }],
    ["rg -n --no-heading 'foo bar' src lib", { label: 'FIND', value: '"foo bar"  src lib' }],
    ['rg --type=ts pat src', { label: 'FIND', value: '"pat"  src' }],
    ['grep TODO', { label: 'FIND', value: '"TODO"' }],
    ['grep -rn pattern .', { label: 'FIND', value: '"pattern"  .' }],
    ['ls', { label: 'LIST', value: '.' }],
    ['ls src/features', { label: 'LIST', value: 'src/features' }],
    ['ls -la src', { label: 'LIST', value: 'src' }],
  ];

  it.each(hits)('prettifies %s', (command, expected) => {
    expect(prettifyShellActivity(command)).toEqual(expected);
  });

  const misses: string[] = [
    'cat a.ts && cat b.ts',
    'ls || true',
    'rg foo | head',
    'cat a.ts; ls',
    'head -n 5 file > out.txt',
    'sort < input.txt',
    'cat $(find .)',
    "rg 'foo|bar' src",
    'rg -C 3 foo src',
    'rg -m 1 pat',
    'rg --type ts pat src',
    "rg -g '*.ts' pat",
    'grep -A 2 pat file',
    'grep -e pattern file',
    'rg -f patterns.txt src',
    'rg --regexp=foo src',
    'rg --files src',
    'rg -n',
    'cat a.ts b.ts',
    'cat',
    'tail log.txt',
    'head file.ts',
    'sed -n 1,240p',
    "sed '1,240p' CLAUDE.md",
    "sed -n '1,240d' CLAUDE.md",
    'ls src lib',
    'ls --sort time',
    'ls -w 80',
    "cat 'unterminated.ts",
    'wc -l CLAUDE.md',
    'npm test',
    '',
  ];

  it.each(misses)('leaves %s as a raw RUN', (command) => {
    expect(prettifyShellActivity(command)).toBeNull();
  });
});
