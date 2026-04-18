import { describe, it, expect } from 'vitest';
import { parseShellCommand } from './parse-shell-command.js';

describe('parseShellCommand', () => {
  it('splits simple commands', () => {
    expect(parseShellCommand('npm test')).toEqual(['npm', 'test']);
  });

  it('handles extra whitespace', () => {
    expect(parseShellCommand('  npm   run   test  ')).toEqual(['npm', 'run', 'test']);
  });

  it('preserves double-quoted arguments', () => {
    expect(parseShellCommand('npm run test -- --grep "foo bar"')).toEqual([
      'npm', 'run', 'test', '--', '--grep', 'foo bar',
    ]);
  });

  it('preserves single-quoted arguments', () => {
    expect(parseShellCommand("npm test -- --grep 'foo bar'")).toEqual([
      'npm', 'test', '--', '--grep', 'foo bar',
    ]);
  });

  it('handles escaped quotes in double-quoted strings', () => {
    expect(parseShellCommand('echo "say \\"hello\\""')).toEqual(['echo', 'say "hello"']);
  });

  it('handles backslash in single-quoted strings literally', () => {
    expect(parseShellCommand("echo 'a\\b'")).toEqual(['echo', 'a\\b']);
  });

  it('handles adjacent quoted and unquoted text', () => {
    expect(parseShellCommand('echo "hello"world')).toEqual(['echo', 'helloworld']);
  });

  it('returns empty array for empty input', () => {
    expect(parseShellCommand('')).toEqual([]);
    expect(parseShellCommand('   ')).toEqual([]);
  });
});
