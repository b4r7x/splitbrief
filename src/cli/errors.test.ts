import { describe, it, expect } from 'vitest';
import { CliError, cliError, isCliError, rethrowAsCli } from './errors.js';

describe('CliError', () => {
  it('is a real Error subclass with a default exit code of 1', () => {
    const err = cliError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toBe('boom');
    expect(err.exitCode).toBe(1);
    expect(err.name).toBe('CliError');
  });

  it('carries a custom exit code', () => {
    expect(cliError('nope', 2).exitCode).toBe(2);
  });

  it('isCliError narrows via instanceof', () => {
    expect(isCliError(cliError('x'))).toBe(true);
    expect(isCliError(new Error('plain'))).toBe(false);
    expect(isCliError({ message: 'x', exitCode: 1 })).toBe(false);
    expect(isCliError(null)).toBe(false);
  });
});

describe('rethrowAsCli', () => {
  it('rethrows an existing CliError unchanged', () => {
    const original = cliError('keep', 7);
    expect(() => rethrowAsCli(original)).toThrow(original);
  });

  it('wraps a non-CliError into a CliError with exit code 1', () => {
    try {
      rethrowAsCli(new Error('underlying'));
      throw new Error('expected throw');
    } catch (err) {
      expect(isCliError(err)).toBe(true);
      if (isCliError(err)) {
        expect(err.message).toBe('underlying');
        expect(err.exitCode).toBe(1);
      }
    }
  });
});
