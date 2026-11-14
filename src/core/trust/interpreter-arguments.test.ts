import { describe, expect, it } from 'vitest';
import { readInterpreterArguments } from './interpreter-arguments.js';
import { isPosixShell } from './interpreter-command-string.js';

describe('shell families', () => {
  it.each(['cmd', 'csh', 'fish', 'powershell', 'pwsh', 'tcsh'])(
    'reads an argument of %s as opaque',
    (name) => {
      expect(readInterpreterArguments(name, ['hooks/check'])).toBe('opaque');
    },
  );

  it.each(['ash', 'bash', 'dash', 'ksh', 'mksh', 'sh', 'zsh'])(
    'reads %s as a POSIX shell',
    (name) => {
      expect(isPosixShell(name)).toBe(true);
    },
  );

  it.each(['csh', 'fish'])('does not read %s as a POSIX shell', (name) => {
    expect(isPosixShell(name)).toBe(false);
  });
});
