import { describe, it, expect } from 'vitest';
import { InvalidArgumentError } from 'commander';
import {
  assertModeFlagsExclusive,
  parseBudgetOption,
  parseNumberOption,
  parsePositiveIntegerOption,
} from './options.js';

describe('parseNumberOption', () => {
  it('parses a finite numeric string', () => {
    expect(parseNumberOption('128000')).toBe(128000);
  });

  it('throws InvalidArgumentError on non-numeric input', () => {
    expect(() => parseNumberOption('abc')).toThrow(InvalidArgumentError);
    expect(() => parseNumberOption('abc')).toThrow(/not a valid number/);
  });
});

describe('parsePositiveIntegerOption', () => {
  it('parses positive integer strings', () => {
    expect(parsePositiveIntegerOption('128000')).toBe(128000);
  });

  it.each(['abc', '1abc', '0', '-1', '1.5', ''])('rejects %j', (value) => {
    expect(() => parsePositiveIntegerOption(value)).toThrow(InvalidArgumentError);
    expect(() => parsePositiveIntegerOption(value)).toThrow(/positive integer/);
  });
});

describe('parseBudgetOption', () => {
  it('parses positive dollar amounts', () => {
    expect(parseBudgetOption('2')).toBe(2);
    expect(parseBudgetOption('2.50')).toBe(2.5);
  });

  it.each(['abc', '1abc', '', '   '])('rejects malformed budget %j', (value) => {
    expect(() => parseBudgetOption(value)).toThrow(InvalidArgumentError);
    expect(() => parseBudgetOption(value)).toThrow(/valid budget amount/);
  });

  it('rejects zero budget as non-positive', () => {
    expect(() => parseBudgetOption('0')).toThrow(InvalidArgumentError);
    expect(() => parseBudgetOption('0')).toThrow(/positive number/);
  });

  it('rejects negative budgets', () => {
    expect(() => parseBudgetOption('-1')).toThrow(InvalidArgumentError);
    expect(() => parseBudgetOption('-1')).toThrow(/valid budget amount/);
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
