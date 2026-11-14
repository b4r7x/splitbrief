import { describe, it, expect } from 'vitest';
import { InvalidArgumentError } from 'commander';
import {
  parseGitRefOption,
  parseNumberOption,
  parseOutputFormatOption,
  parsePositiveIntegerOption,
  parseSeatDownPolicyOption,
} from './parsers.js';
import { parseWorkflowOptions } from '#testing/helpers/workflow-options.js';

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

describe('parseOutputFormatOption', () => {
  it.each(['stream-json', 'jsonl', 'text', 'opencode'])('accepts %j', (value) => {
    expect(parseOutputFormatOption(value)).toBe(value);
  });

  it.each(['json', 'yaml', '', 'STREAM-JSON'])('rejects %j with a friendly error', (value) => {
    expect(() => parseOutputFormatOption(value)).toThrow(InvalidArgumentError);
    expect(() => parseOutputFormatOption(value)).toThrow(/not a valid output format/);
    expect(() => parseOutputFormatOption(value)).toThrow(/stream-json, jsonl, text, opencode/);
  });
});

describe('parseSeatDownPolicyOption', () => {
  it.each(['halt', 'switch'] as const)('accepts %j', (value) => {
    expect(parseSeatDownPolicyOption(value)).toBe(value);
  });

  it.each(['auto', 'HALT', ''])('rejects %j with a friendly error', (value) => {
    expect(() => parseSeatDownPolicyOption(value)).toThrow(InvalidArgumentError);
    expect(() => parseSeatDownPolicyOption(value)).toThrow(/not a valid seat-down policy/);
    expect(() => parseSeatDownPolicyOption(value)).toThrow(/halt, switch/);
  });

  it('registers --on-seat-down on the workflow options', () => {
    expect(parseWorkflowOptions(['--on-seat-down', 'switch'])).toMatchObject({
      onSeatDown: 'switch',
    });
    expect(parseWorkflowOptions([]).onSeatDown).toBeUndefined();
  });
});

describe('parseGitRefOption', () => {
  it('returns a trimmed ref', () => {
    expect(parseGitRefOption(' main ')).toBe('main');
  });

  it('rejects an option-shaped ref that git would read as a flag', () => {
    expect(() => parseGitRefOption('--output=/tmp/steal.txt')).toThrow(InvalidArgumentError);
    expect(() => parseGitRefOption('-p')).toThrow("cannot start with '-'");
  });

  it('rejects an empty ref', () => {
    expect(() => parseGitRefOption('   ')).toThrow(InvalidArgumentError);
  });
});
