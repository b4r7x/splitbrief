import { describe, it, expect } from 'vitest';
import { Command, InvalidArgumentError } from 'commander';
import { IMPLEMENTER_API_PROVIDER_IDS } from '../core/providers/api-provider-catalog.js';
import { IMPLEMENTER_CLI_TOOL_IDS } from '../core/runners/cli-tool-catalog.js';
import { META_PROVIDER_IDS, PLANNER_TOOL_IDS } from '../core/schemas/enums.js';
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

function idsListedInHelp(label: string): string[] {
  const help = addWorkflowOptions(new Command()).helpInformation().replace(/\s+/g, ' ');
  const listed = new RegExp(`${label} \\(([^)]+)\\)`).exec(help)?.[1];
  if (listed === undefined) throw new Error(`no "${label}" entry in --help`);
  return listed.split(', ');
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
  // The flag grants every shell/agent command the project config declares, not
  // only the repo-local ones, so the help must not say "repo-local".
  it('explains the headless grant it actually gives', () => {
    const help = addWorkflowOptions(new Command()).helpInformation();

    expect(help).toContain(
      'Grant this run the shell/agent runner commands the project config declares (headless use)',
    );
    expect(help).not.toContain('Grant repo-local legacy runners');
  });
});

describe('runner selection help', () => {
  it.each([
    { label: 'Planner tool', admitted: [...PLANNER_TOOL_IDS] },
    { label: 'Reviewer tool', admitted: [...PLANNER_TOOL_IDS] },
    {
      label: 'Implementer provider',
      admitted: [
        ...IMPLEMENTER_CLI_TOOL_IDS,
        ...IMPLEMENTER_API_PROVIDER_IDS,
        ...META_PROVIDER_IDS,
      ],
    },
  ])('$label enumerates every id the catalog admits', ({ label, admitted }) => {
    expect(idsListedInHelp(label)).toEqual(admitted);
  });

  it('lists the surviving ids, and no removed one', () => {
    expect(idsListedInHelp('Planner tool')).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'copilot',
      'kilo-code',
      'cursor',
      'command-code',
      'shell',
      'agent',
    ]);
    expect(idsListedInHelp('Implementer provider')).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'copilot',
      'kilo-code',
      'cursor',
      'command-code',
      'ollama',
      'lm-studio',
      'shell',
      'agent',
    ]);
  });
});

describe('reviewer seat flags', () => {
  it('parses every reviewer override the planner set mirrors', () => {
    const opts = parseWorkflowOptions([
      '--reviewer',
      'codex',
      '--reviewer-model',
      'gpt-5',
      '--reviewer-command',
      'my-reviewer',
      '--reviewer-api-base',
      'https://api.example.com/v1',
      '--reviewer-api-key-env',
      'MY_KEY',
      '--reviewer-args',
      '--flag-a',
      '--reviewer-args',
      '--flag-b',
      '--reviewer-output-format',
      'jsonl',
      '--reviewer-context-length',
      '128000',
      '--reviewer-effort',
      'high',
    ]);

    expect(opts).toMatchObject({
      reviewer: 'codex',
      reviewerModel: 'gpt-5',
      reviewerCommand: 'my-reviewer',
      reviewerApiBase: 'https://api.example.com/v1',
      reviewerApiKeyEnv: 'env:MY_KEY',
      reviewerArgs: ['--flag-a', '--flag-b'],
      reviewerOutputFormat: 'jsonl',
      reviewerContextLength: 128000,
      reviewerEffort: 'high',
    });
  });

  it('admits a provider outside the catalog, exactly as --planner does', () => {
    const opts = parseWorkflowOptions([
      '--planner',
      'some-custom-provider',
      '--reviewer',
      'some-custom-provider',
    ]);

    expect(opts).toMatchObject({
      planner: 'some-custom-provider',
      reviewer: 'some-custom-provider',
    });
  });

  it('leaves an out-of-catalog reviewer for the config layer to admit', async () => {
    const { stderr } = await runCommand(['start', '--reviewer', 'some-custom-provider', 'x']);

    expect(stderr).not.toContain("option '--reviewer <tool>'");
  });
});

describe('removed --auto flag', () => {
  it.each(['start', 'spec', 'resume', 'continue', 'last'])(
    'rejects --auto on the %s command',
    async (command) => {
      const { exitCode, stderr } = await runCommand([command, '--auto', 'add health endpoint']);

      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/unknown option.*--auto/i);
    },
  );
});
