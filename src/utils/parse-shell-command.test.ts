import { describe, expect, it } from 'vitest';
import { parseShellCommand, scanShellWords } from './parse-shell-command.js';

describe('parseShellCommand', () => {
  it.each([
    ['npm test', ['npm', 'test']],
    ['  npm   run   test  ', ['npm', 'run', 'test']],
    ['npm run test -- --grep "foo bar"', ['npm', 'run', 'test', '--', '--grep', 'foo bar']],
    ["npm test -- --grep 'foo bar'", ['npm', 'test', '--', '--grep', 'foo bar']],
    ['cmd "" \'\' " "', ['cmd', '', '', ' ']],
    ['echo "say \\"hello\\""', ['echo', 'say "hello"']],
    ["echo 'a\\b'", ['echo', 'a\\b']],
    ['echo "hello"world', ['echo', 'helloworld']],
    [String.raw`grep -E "a\|b"`, ['grep', '-E', String.raw`a\|b`]],
    [String.raw`printf "a\nb"`, ['printf', String.raw`a\nb`]],
    [String.raw`echo "\$HOME \`hi\` \\ path"`, ['echo', '$HOME `hi` \\ path']],
    ['echo a\\\nb c', ['echo', 'ab', 'c']],
    ['echo "a\\\nb"', ['echo', 'ab']],
    ['echo \\\n next', ['echo', 'next']],
    [String.raw`echo 'a\nb'`, ['echo', String.raw`a\nb`]],
    [String.raw`echo pre'quoted '\''post'`, ['echo', "prequoted 'post"]],
    ["echo 'unfinished", ['echo', 'unfinished']],
    ['echo "unfinished', ['echo', 'unfinished']],
    ['echo trailing\\', ['echo', 'trailing']],
    ['echo "trailing\\', ['echo', 'trailing']],
    ['\\', []],
    [String.raw`echo $'a\nb'`, ['echo', String.raw`$a\nb`]],
    ['echo $"hi"', ['echo', '$hi']],
    ['echo foo | wc -c && echo "$HOME"', ['echo', 'foo', '|', 'wc', '-c', '&&', 'echo', '$HOME']],
    ['', []],
    ['   ', []],
  ])('splits command text into argv tokens', (input, expected) => {
    expect(parseShellCommand(input)).toEqual(expected);
  });
});

describe('scanShellWords', () => {
  it.each([
    ['', true],
    ['echo "" \'\' pre"quoted "post', true],
    [String.raw`echo '\'`, true],
    [String.raw`echo "\q"`, true],
    ['echo a\\\nb', true],
    [`echo "$'literal'"`, true],
    [String.raw`echo '\$"literal"'`, true],
    [String.raw`echo \$'literal'`, true],
    ["echo 'unfinished", false],
    ['echo "unfinished', false],
    ['echo trailing\\', false],
    ['echo "trailing\\', false],
    [String.raw`echo $'a\nb'`, false],
    ['echo $"hi"', false],
    ["echo pre$'hi'", false],
  ])('reports completeness for %s', (input, complete) => {
    expect(scanShellWords(input).complete).toBe(complete);
  });
});
