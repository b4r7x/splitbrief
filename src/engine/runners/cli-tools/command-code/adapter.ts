import { CLI_TOOL_CATALOG } from '../../../../core/runners/cli-tool/catalog.js';
import { commandCodeProtocolEvents, commandCodeTerminal } from './protocol.js';
import type { CliPlannerAdapter, CliImplementerAdapter } from '../contract.js';
import { validateCliArgs } from '../validate-args.js';

export const COMMAND_CODE_ID = 'command-code' as const;
export const COMMAND_CODE_COMMAND = 'cmd' as const;
const COMMAND_CODE_PROMPT_TRANSPORT = Object.freeze({ kind: 'stdin' } as const);
export const COMMAND_CODE_VERSION_ARGS = Object.freeze(['--version', '--no-auto-update'] as const);
// `cmd -p` stops after 100 turns and `--max-turns` takes only a positive integer, so the
// largest int32 turns the cap off. A configured `--max-turns` comes later and wins.
const COMMAND_CODE_NO_TURN_CAP = '2147483647';

export const COMMAND_CODE_PROTECTED_FLAGS = new Set([
  '-p',
  '--print',
  '--output-format',
  '-m',
  '--model',
  '--permission-mode',
  '--auto-accept',
  '--yolo',
  '--dangerously-skip-permissions',
  '--trust',
  '-t',
  '--skip-onboarding',
  '-r',
  '--resume',
  '--session',
  '--fork-session',
  '--config',
  // Native options the adapter never emits, refused because they take over
  // adapter-owned authority: `-w`/`--worktree` moves the run out of the stage
  // directory SPLITBRIEF owns, and `--mod`/`--mod-option` load extension
  // configuration SPLITBRIEF never sees.
  '--worktree',
  '-w',
  '--mod',
  '--mod-option',
  '--effort',
  '--no-auto-update',
  '-v',
  '--version',
]);
export const COMMAND_CODE_PROTECTED_SHORT_VALUE_FLAGS = new Set(['-p', '-m', '-r', '-w']);

type CommandCodePlannerBuildInput = Parameters<CliPlannerAdapter<'command-code'>['buildArgs']>[0];
type CommandCodeImplementerBuildInput = Parameters<
  CliImplementerAdapter<'command-code'>['buildArgs']
>[0];

function validateArgs(input: { invocationArgs: readonly string[]; baseArgs: readonly string[] }) {
  return validateCliArgs({
    ...input,
    protectedFlags: COMMAND_CODE_PROTECTED_FLAGS,
    protectedShortValueFlags: COMMAND_CODE_PROTECTED_SHORT_VALUE_FLAGS,
    positionalPrompt: true,
  });
}

function plannerBaseArgs(input: CommandCodePlannerBuildInput): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--trust',
    '--skip-onboarding',
    '--no-auto-update',
    '--max-turns',
    COMMAND_CODE_NO_TURN_CAP,
    '--permission-mode',
    'plan',
    ...(input.model === undefined ? [] : ['-m', input.model]),
    ...(input.effort === undefined ? [] : ['--effort', input.effort]),
  ];
}

function implementerBaseArgs(input: CommandCodeImplementerBuildInput): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--trust',
    '--skip-onboarding',
    '--no-auto-update',
    '--max-turns',
    COMMAND_CODE_NO_TURN_CAP,
    // `--permission-mode auto-accept` still prompts for every write and shell call in
    // `-p` mode (cmd 1.50.1 answers "requires permissions. Use --yolo"); `--yolo` is the
    // headless write flag.
    '--yolo',
    ...(input.model === undefined ? [] : ['-m', input.model]),
    ...(input.effort === undefined ? [] : ['--effort', input.effort]),
  ];
}

function createProbe() {
  return {
    version: {
      command: [COMMAND_CODE_COMMAND, ...COMMAND_CODE_VERSION_ARGS],
      cwd: 'neutral',
      maxOutputBytes: 4_096,
    },
  } as const;
}

function createCommandCodePlannerAdapter(): CliPlannerAdapter<'command-code'> {
  return {
    descriptor: CLI_TOOL_CATALOG['command-code'],
    role: 'planner',
    supportsSessionResume: false,
    supportsEffort: CLI_TOOL_CATALOG['command-code'].supportsEffort,
    promptTransport: COMMAND_CODE_PROMPT_TRANSPORT,
    baseArgs: plannerBaseArgs,
    buildArgs: (input) => [...plannerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' },
    parse: commandCodeProtocolEvents,
    terminal: commandCodeTerminal,
    probe: createProbe(),
  };
}

function createCommandCodeImplementerAdapter(): CliImplementerAdapter<'command-code'> {
  return {
    descriptor: CLI_TOOL_CATALOG['command-code'],
    role: 'implementer',
    promptTransport: COMMAND_CODE_PROMPT_TRANSPORT,
    baseArgs: implementerBaseArgs,
    buildArgs: (input) => [...implementerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' },
    parse: commandCodeProtocolEvents,
    terminal: commandCodeTerminal,
    probe: createProbe(),
  };
}

export const commandCodePlannerAdapter = createCommandCodePlannerAdapter();
export const commandCodeImplementerAdapter = createCommandCodeImplementerAdapter();
