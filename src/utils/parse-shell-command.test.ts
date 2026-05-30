import { describe, expect, it } from 'vitest';
import { parseShellCommand } from './parse-shell-command.js';

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
    ['echo foo | wc -c && echo "$HOME"', ['echo', 'foo', '|', 'wc', '-c', '&&', 'echo', '$HOME']],
    ['', []],
    ['   ', []],
  ])('splits command text into argv tokens', (input, expected) => {
    expect(parseShellCommand(input)).toEqual(expected);
  });
});
