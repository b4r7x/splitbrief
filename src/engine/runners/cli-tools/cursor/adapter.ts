import { CLI_TOOL_CATALOG } from '../../../../core/runners/cli-tool/catalog.js';
import type { CliPlannerAdapter, CliImplementerAdapter } from '../contract.js';
import { cursorProtocolEvents, cursorTerminal } from './protocol.js';
import { validateCliArgs } from '../validate-args.js';

export const CURSOR_ID = 'cursor' as const;
export const CURSOR_COMMAND = 'cursor-agent' as const;
const CURSOR_PROMPT_TRANSPORT = Object.freeze({ kind: 'stdin' } as const);
export const CURSOR_VERSION_ARGS = Object.freeze(['--version'] as const);

export const CURSOR_PROTECTED_FLAGS = new Set([
  '--print',
  '--output-format',
  '--model',
  '--force',
  '--trust',
  '--yolo',
  '--sandbox',
  '--workspace',
  '--worktree',
  '--worktree-base',
  '--skip-worktree-setup',
  '--add-dir',
  '--api-key',
  '--endpoint',
  '--mode',
  '--plan',
  '--auto-review',
  '--header',
  '-p',
  '-f',
  '-e',
  '-w',
  '-H',
]);
export const CURSOR_PROTECTED_SHORT_VALUE_FLAGS = new Set(['-p', '-f', '-e', '-w', '-H']);

type CursorPlannerBuildInput = Parameters<CliPlannerAdapter<'cursor'>['buildArgs']>[0];
type CursorImplementerBuildInput = Parameters<CliImplementerAdapter<'cursor'>['buildArgs']>[0];

function validateArgs(input: { invocationArgs: readonly string[]; baseArgs: readonly string[] }) {
  return validateCliArgs({
    ...input,
    protectedFlags: CURSOR_PROTECTED_FLAGS,
    protectedShortValueFlags: CURSOR_PROTECTED_SHORT_VALUE_FLAGS,
    positionalPrompt: true,
  });
}

// `--workspace` defaults to the cwd; naming the seat directory keeps the workspace
// `--trust` trusts and the one the agent works in the same, whatever that default becomes.
function plannerBaseArgs(input: CursorPlannerBuildInput): string[] {
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--mode',
    'plan',
    '--trust',
    '--workspace',
    input.projectDir,
    ...(input.model === undefined ? [] : ['--model', input.model]),
  ];
}

function implementerBaseArgs(input: CursorImplementerBuildInput): string[] {
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--force',
    '--trust',
    '--workspace',
    input.projectDir,
    ...(input.model === undefined ? [] : ['--model', input.model]),
  ];
}

function createProbe() {
  return {
    version: {
      command: [CURSOR_COMMAND, ...CURSOR_VERSION_ARGS] as const,
      cwd: 'neutral' as const,
      maxOutputBytes: 4_096,
    },
  } as const;
}

function createCursorPlannerAdapter(): CliPlannerAdapter<'cursor'> {
  return {
    descriptor: CLI_TOOL_CATALOG.cursor,
    role: 'planner',
    supportsSessionResume: false,
    supportsEffort: CLI_TOOL_CATALOG.cursor.supportsEffort,
    promptTransport: CURSOR_PROMPT_TRANSPORT,
    baseArgs: plannerBaseArgs,
    buildArgs: (input) => [...plannerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' },
    parse: cursorProtocolEvents,
    terminal: cursorTerminal,
    probe: createProbe(),
  };
}

function createCursorImplementerAdapter(): CliImplementerAdapter<'cursor'> {
  return {
    descriptor: CLI_TOOL_CATALOG.cursor,
    role: 'implementer',
    promptTransport: CURSOR_PROMPT_TRANSPORT,
    baseArgs: implementerBaseArgs,
    buildArgs: (input) => [...implementerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' },
    parse: cursorProtocolEvents,
    terminal: cursorTerminal,
    probe: createProbe(),
  };
}

export const cursorPlannerAdapter = createCursorPlannerAdapter();
export const cursorImplementerAdapter = createCursorImplementerAdapter();
