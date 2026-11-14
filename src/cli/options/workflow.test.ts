import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import * as apiProviderCatalog from '../../core/providers/api-provider-catalog.js';
import { IMPLEMENTER_API_PROVIDER_IDS } from '../../core/providers/api-provider-catalog.js';
import { IMPLEMENTER_CLI_TOOL_IDS, isListedCliTool } from '../../core/runners/cli-tool/catalog.js';
import { EFFORT_LEVELS, META_PROVIDER_IDS, PLANNER_TOOL_IDS } from '../../core/schemas/enums.js';
import { addWorkflowOptions } from './workflow.js';
import { runCommand } from '#testing/helpers/commander.js';
import { parseWorkflowOptions } from '#testing/helpers/workflow-options.js';

function idsListedInHelp(label: string): string[] {
  const help = addWorkflowOptions(new Command()).helpInformation().replace(/\s+/g, ' ');
  const start = help.indexOf(label);
  if (start === -1) throw new Error(`no "${label}" entry in --help`);
  // The entry runs to the next option term; its ids are the last parenthetical,
  // after any explanatory one the label's sentence carries.
  const entry = help.slice(start).split(/ --/)[0] ?? '';
  const listed = /.*\(([^)]+)\)/.exec(entry)?.[1];
  if (listed === undefined) throw new Error(`no "${label}" id list in --help`);
  return listed.split(', ');
}

function levelsListedInHelp(seat: string): string[] {
  const help = addWorkflowOptions(new Command()).helpInformation().replace(/\s+/g, ' ');
  const listed = new RegExp(`${seat} effort hint: ([^.]+)\\.`).exec(help)?.[1];
  if (listed === undefined) throw new Error(`no "${seat} effort hint" entry in --help`);
  return listed.split(', ');
}

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
    { label: 'Planner tool', admitted: PLANNER_TOOL_IDS },
    { label: 'Reviewer tool', admitted: PLANNER_TOOL_IDS },
    {
      label: 'Implementer provider',
      admitted: [
        ...IMPLEMENTER_CLI_TOOL_IDS,
        ...IMPLEMENTER_API_PROVIDER_IDS,
        ...META_PROVIDER_IDS,
      ],
    },
  ])('$label enumerates every id the catalog lists', ({ label, admitted }) => {
    expect(apiProviderCatalog.isListedApiProvider).toBeTypeOf('function');
    expect(idsListedInHelp(label)).toEqual(
      admitted.filter((id) => isListedCliTool(id) && apiProviderCatalog.isListedApiProvider(id)),
    );
  });

  it('lists the surviving ids, and no removed or unlisted one', () => {
    expect(idsListedInHelp('Planner tool')).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'kilo-code',
      'cursor',
      'command-code',
      'antigravity',
      'shell',
      'agent',
    ]);
    expect(idsListedInHelp('Reviewer tool')).toEqual(idsListedInHelp('Planner tool'));
    expect(idsListedInHelp('Implementer provider')).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'kilo-code',
      'cursor',
      'command-code',
      'antigravity',
      'shell',
      'agent',
    ]);
  });
});

describe('unlisted local provider flags', () => {
  it.each(['--planner', '--reviewer', '--implementer', '--provider'])(
    'still parses ollama on %s',
    (flag) => {
      const key = flag.slice(2);
      expect(parseWorkflowOptions([flag, 'ollama'])).toMatchObject({ [key]: 'ollama' });
    },
  );
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
