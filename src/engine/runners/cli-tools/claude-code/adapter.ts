import { CLI_TOOL_CATALOG } from '../../../../core/runners/cli-tool/catalog.js';
import { error } from '../../../../utils/error.js';
import type {
  CliPlannerAdapter,
  CliImplementerAdapter,
  CliInvocation,
  CliProtocolEvent,
} from '../contract.js';
import { plannerBaseArgs, implementerBaseArgs, validateArgs } from './args.js';
import { toProtocolEvents, createClaudeParser } from './protocol.js';
import { inputLine, CLAUDE_STEERING } from './steering.js';

export const CLAUDE_COMMAND = 'claude' as const;
export const CLAUDE_ID = 'claude-code' as const;
const CLAUDE_PROMPT_TRANSPORT = Object.freeze({ kind: 'stdin' } as const);

function createProbe() {
  return {
    version: {
      command: [CLAUDE_COMMAND, '--version'] as const,
      cwd: 'neutral' as const,
      maxOutputBytes: 4_096,
    },
  } as const;
}

function createAdapter(role: 'planner'): CliPlannerAdapter<'claude-code'>;
function createAdapter(role: 'implementer'): CliImplementerAdapter<'claude-code'>;
function createAdapter(
  role: 'planner' | 'implementer',
): CliPlannerAdapter<'claude-code'> | CliImplementerAdapter<'claude-code'> {
  const shared = {
    descriptor: CLI_TOOL_CATALOG[CLAUDE_ID],
    role,
    promptTransport: CLAUDE_PROMPT_TRANSPORT,
    encodePrompt: ({ invocation, prompt }: { invocation: CliInvocation; prompt: string }) =>
      invocation.args.includes('--input-format')
        ? inputLine(prompt, invocation.images)
        : Promise.resolve(prompt),
    steering: CLAUDE_STEERING,
    validateArgs,
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' } as const,
    parse: toProtocolEvents,
    createParser: createClaudeParser,
    terminal: ({ events }: { events: readonly CliProtocolEvent[] }) => {
      const terminal = events.findLast((event) => event.type === 'result');
      if (terminal === undefined || terminal.type !== 'result') {
        throw error('protocol-failure', 'Claude Code output ended without a terminal result');
      }
      return terminal;
    },
    probe: createProbe(),
  };

  if (role === 'planner') {
    return {
      ...shared,
      role,
      supportsSessionResume: true,
      supportsEffort: CLI_TOOL_CATALOG[CLAUDE_ID].supportsEffort,
      baseArgs: plannerBaseArgs,
      buildArgs: (input) => [...plannerBaseArgs(input), ...input.configuredArgs],
    } satisfies CliPlannerAdapter<'claude-code'>;
  }

  return {
    ...shared,
    role,
    baseArgs: implementerBaseArgs,
    buildArgs: (input) => [...implementerBaseArgs(input), ...input.configuredArgs],
  } satisfies CliImplementerAdapter<'claude-code'>;
}

export const claudeCodePlannerAdapter = createAdapter('planner');
export const claudeCodeImplementerAdapter = createAdapter('implementer');
