import { describe, it, expect } from 'vitest';
import { InvalidArgumentError } from 'commander';
import { assertModeFlagsExclusive, parseNumberOption } from './options.js';

describe('parseNumberOption', () => {
  it('parses a finite numeric string', () => {
    expect(parseNumberOption('128000')).toBe(128000);
  });

  it('throws InvalidArgumentError on non-numeric input', () => {
    expect(() => parseNumberOption('abc')).toThrow(InvalidArgumentError);
    expect(() => parseNumberOption('abc')).toThrow(/not a valid number/);
  });
});

describe('assertModeFlagsExclusive', () => {
  it('throws when both --json and --rpc are set', () => {
    expect(() => assertModeFlagsExclusive({ json: true, rpc: true })).toThrow(/--json and --rpc/);
  });

  it.each([
    { json: true, rpc: false },
    { json: false, rpc: true },
    { json: false, rpc: false },
    {},
  ])('accepts %o', (opts) => {
    expect(() => assertModeFlagsExclusive(opts)).not.toThrow();
  });
});
