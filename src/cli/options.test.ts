import { describe, it, expect } from 'vitest';
import { Command, InvalidArgumentError } from 'commander';
import type { WorkflowOpts } from '../core/types/config-options.js';
import {
  addWorkflowOptions,
  assertModeFlagsExclusive,
  parseBudgetOption,
  parseNumberOption,
  parseOutputFormatOption,
  parsePositiveIntegerOption,
} from './options.js';
import { runCommand } from '#testing/helpers/commander.js';

function parseWorkflowOptions(args: string[]): WorkflowOpts {
  const command = addWorkflowOptions(new Command());
  command.parse(['node', 'splitbrief', ...args]);
  return command.opts<WorkflowOpts>();
}

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

describe('--allow-unverified-auth', () => {
  it.each([
    { args: [], expected: false },
    { args: ['--allow-unverified-auth'], expected: true },
  ])('Commander parses %o as $expected', ({ args, expected }) => {
    expect(parseWorkflowOptions(args).allowUnverifiedAuth).toBe(expected);
  });
});

describe('--allow-repo-runners', () => {
  it('explains its legacy-runner and headless custom-command grant', () => {
    const help = addWorkflowOptions(new Command()).helpInformation();

    expect(help).toContain(
      'Grant repo-local legacy runners and configured custom commands in headless use',
    );
  });
});

describe('removed --auto flag', () => {
  it.each([
    'start',
    'spec',
    'resume',
    'continue',
    'last',
  ])('rejects --auto on the %s command', async (command) => {
    const { exitCode, stderr } = await runCommand([command, '--auto', 'add health endpoint']);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/unknown option.*--auto/i);
  });
});
