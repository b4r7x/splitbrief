import { describe, it, expect } from 'vitest';
import { Command, InvalidArgumentError } from 'commander';
import { IMPLEMENTER_API_PROVIDER_IDS } from '../core/providers/api-provider-catalog.js';
import { IMPLEMENTER_CLI_TOOL_IDS } from '../core/runners/cli-tool-catalog.js';
import { EFFORT_LEVELS, META_PROVIDER_IDS, PLANNER_TOOL_IDS } from '../core/schemas/enums.js';
import type { WorkflowOpts } from '../core/types/config-options.js';
import {
  addWorkflowOptions,
  parseBudgetOption,
  parseGitRefOption,
  parseNumberOption,
  parseOutputFormatOption,
  parsePositiveIntegerOption,
  parseSeatSpecOption,
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

function levelsListedInHelp(seat: string): string[] {
  const help = addWorkflowOptions(new Command()).helpInformation().replace(/\s+/g, ' ');
  const listed = new RegExp(`${seat} effort hint: ([^.]+)\\.`).exec(help)?.[1];
  if (listed === undefined) throw new Error(`no "${seat} effort hint" entry in --help`);
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

describe('parseSeatSpecOption', () => {
  it.each([
    { spec: 'codex', expected: { tool: 'codex' } },
    { spec: 'codex@high', expected: { tool: 'codex', effort: 'high' } },
    {
      spec: 'cmd:deepseek/deepseek-v4-flash',
      expected: { tool: 'cmd', model: 'deepseek/deepseek-v4-flash' },
    },
    {
      spec: 'opencode:opencode-go/kimi-k3@high',
      expected: { tool: 'opencode', model: 'opencode-go/kimi-k3', effort: 'high' },
    },
    {
      spec: 'cursor:gpt-5.3-codex-high',
      expected: { tool: 'cursor', model: 'gpt-5.3-codex-high' },
    },
  ])('reads $spec', ({ spec, expected }) => {
    expect(parseSeatSpecOption(spec)).toEqual(expected);
  });

  it('splits on the first colon, so a model id may carry its own', () => {
    expect(parseSeatSpecOption('api:openai:gpt-5')).toEqual({ tool: 'api', model: 'openai:gpt-5' });
  });

  it.each(['', '@high', ':model', 'codex:', 'codex@'])('rejects %j', (spec) => {
    expect(() => parseSeatSpecOption(spec)).toThrow(InvalidArgumentError);
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
    const help = addWorkflowOptions(new Command()).helpInformation().replace(/\s+/g, ' ');

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

describe('effort help', () => {
  it.each(['Planner', 'Reviewer'])('%s effort hint enumerates every admitted level', (seat) => {
    expect(levelsListedInHelp(seat)).toEqual([...EFFORT_LEVELS]);
  });
});

describe('help layout', () => {
  // Commander stops wrapping altogether once the widest term leaves a description fewer
  // than minWidthToWrap columns, so one over-wide option added below un-wraps the whole
  // list. Shared options only: an option a command declares for itself widens the same
  // gutter and is out of this unit's reach.
  it('wraps every shared workflow description inside an 80-column terminal', () => {
    const command = addWorkflowOptions(new Command());
    command.configureOutput({ getOutHelpWidth: () => 80 });

    const lines = command.helpInformation().split('\n');

    expect(lines.filter((line) => line.length > 80)).toEqual([]);
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
  it.each(['start', 'spec', 'resume', 'continue'])(
    'rejects --auto on the %s command',
    async (command) => {
      const { exitCode, stderr } = await runCommand([command, '--auto', 'add health endpoint']);

      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/unknown option.*--auto/i);
    },
  );
});

describe('--plain and --json exclusivity', () => {
  it.each(['start', 'resume', 'continue'])(
    'rejects both output modes on the %s command with exit code 2',
    async (command) => {
      const { exitCode, stderr } = await runCommand([command, '--plain', '--json']);

      expect(exitCode).toBe(2);
      expect(stderr).toContain('--plain and --json cannot be combined');
    },
  );

  it('accepts --plain on its own', () => {
    const command = addWorkflowOptions(new Command());
    command.parse(['node', 'splitbrief', '--plain']);

    expect(command.opts().plain).toBe(true);
    expect(command.opts().json).toBe(false);
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
