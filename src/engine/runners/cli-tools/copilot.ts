import { accumulateTokenUsage } from '../../calls/usage.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { ParsedLine } from '../types.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { validateCliArgs } from './validate-args.js';
import { parseTextLine } from '../../streaming/parse-text.js';
import { parseCopilotLine } from '../../streaming/parse-copilot.js';

const COPILOT_ID = 'copilot' as const;
const COPILOT_COMMAND = 'copilot' as const;
const COPILOT_PROMPT_TRANSPORT = Object.freeze({
  kind: 'argv',
  maxBytes: 120_000,
  placement: 'flag-value',
} as const);
const COPILOT_VERSION_ARGS = Object.freeze(['--version'] as const);

const COPILOT_PROTECTED_FLAGS = new Set([
  '--agent',
  '--allow-all',
  '--allow-all-tools',
  '--autopilot',
  '--model',
  '--mode',
  '--no-ask-user',
  '--output-format',
  '--plan',
  '--prompt',
  '--yolo',
  '-p',
]);
const COPILOT_PROTECTED_SHORT_VALUE_FLAGS = new Set(['-p']);

type CopilotPlannerBuildInput = Parameters<CliPlannerAdapter<'copilot'>['buildArgs']>[0];
type CopilotImplementerBuildInput = Parameters<CliImplementerAdapter<'copilot'>['buildArgs']>[0];
type CopilotTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function validateArgs(input: { invocationArgs: readonly string[]; baseArgs: readonly string[] }) {
  return validateCliArgs({
    ...input,
    protectedFlags: COPILOT_PROTECTED_FLAGS,
    protectedShortValueFlags: COPILOT_PROTECTED_SHORT_VALUE_FLAGS,
    promptTransport: 'argv',
  });
}

function toProtocolEvents(parsed: ParsedLine): readonly CliProtocolEvent[] {
  const events: CliProtocolEvent[] = [];
  if (parsed.text !== undefined && parsed.text.length > 0) {
    events.push({
      type: 'text',
      channel: parsed.channel ?? (parsed.isResult ? 'result' : 'stdout'),
      text: parsed.text,
    });
  }
  if (parsed.usage !== undefined) {
    events.push({
      type: 'usage',
      usage: parsed.usage,
      semantics: parsed.usageSemantics ?? (parsed.isResult ? 'final' : 'delta'),
    });
  }
  if (parsed.sessionId !== undefined)
    events.push({ type: 'session', nativeSessionId: parsed.sessionId });
  for (const toolUse of [...(parsed.toolUse ?? []), ...(parsed.toolUseDone ?? [])]) {
    events.push({
      type: 'tool-use',
      id: toolUse.id ?? null,
      name: toolUse.name,
      input: { ...toolUse.input },
      ...(toolUse.output !== undefined && { output: toolUse.output }),
    });
  }
  for (const warning of parsed.warning ?? []) {
    events.push({ type: 'warning', code: warning.code, message: warning.message });
  }
  return events;
}

export function copilotPlannerProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return toProtocolEvents(parseCopilotLine(line));
}

export function copilotImplementerProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return toProtocolEvents(parseTextLine(line));
}

function terminal(input: { events: readonly CliProtocolEvent[] }): CopilotTerminalEvent {
  let usage: TokenDelta | null = null;
  let nativeSessionId: string | null = null;
  for (const event of input.events) {
    if (event.type === 'usage') usage = accumulateTokenUsage(usage, event.usage, event.semantics);
    if (event.type === 'session') nativeSessionId = event.nativeSessionId;
  }
  return {
    type: 'result',
    status: 'completed',
    text: '',
    usage,
    nativeSessionId,
    error: null,
    partial: false,
  };
}

function plannerBaseArgs(input: CopilotPlannerBuildInput): string[] {
  return [
    ...(input.model === undefined ? [] : ['--model', input.model]),
    '-p',
    input.prompt,
    ...(input.mode === 'plan'
      ? ['--plan', '--allow-all-tools', '--no-ask-user']
      : ['--allow-all', '--no-ask-user']),
    '--output-format',
    'json',
  ];
}

function implementerBaseArgs(input: CopilotImplementerBuildInput): string[] {
  return [
    ...(input.model === undefined ? [] : ['--model', input.model]),
    '-p',
    input.prompt,
    '--allow-all',
  ];
}

function createProbe() {
  return {
    version: {
      command: [COPILOT_COMMAND, ...COPILOT_VERSION_ARGS] as const,
      cwd: 'neutral' as const,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
    auth: {
      command: [COPILOT_COMMAND, 'auth', 'status'] as const,
      cwd: 'neutral' as const,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
  } as const;
}

function createPlannerAdapter(): CliPlannerAdapter<'copilot'> {
  return {
    descriptor: CLI_TOOL_CATALOG.copilot,
    role: 'planner',
    supportsSessionResume: false,
    supportsEffort: CLI_TOOL_CATALOG.copilot.supportsEffort,
    promptTransport: COPILOT_PROMPT_TRANSPORT,
    baseArgs: plannerBaseArgs,
    buildArgs: (input) => [...plannerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: copilotPlannerProtocolEvents,
    terminal,
    probe: createProbe(),
  };
}

function createImplementerAdapter(): CliImplementerAdapter<'copilot'> {
  return {
    descriptor: CLI_TOOL_CATALOG.copilot,
    role: 'implementer',
    promptTransport: COPILOT_PROMPT_TRANSPORT,
    baseArgs: implementerBaseArgs,
    buildArgs: (input) => [...implementerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: copilotImplementerProtocolEvents,
    terminal,
    probe: createProbe(),
  };
}

export const copilotPlannerAdapter = createPlannerAdapter();
export const copilotImplementerAdapter = createImplementerAdapter();

export type RawCopilotCliContract = Readonly<{
  id: typeof COPILOT_ID;
  command: typeof COPILOT_COMMAND;
  role: 'planner' | 'implementer';
  versionArgs: readonly ['--version'];
  auth: Readonly<{ kind: 'env-or-native'; env: readonly ['GH_TOKEN', 'GITHUB_TOKEN'] }>;
  rawInvocation: readonly string[];
  promptTransport: 'argv';
  expectedRawTerminal: 'process-exit';
  asOf: '2026-07-31';
}>;

export type CopilotCliConformanceCandidate = Readonly<{
  id: typeof COPILOT_ID;
  role: 'planner' | 'implementer';
  rawContract: RawCopilotCliContract;
  contractSha256: string;
  adapter: CliPlannerAdapter<'copilot'> | CliImplementerAdapter<'copilot'>;
}>;

function rawContract(role: 'planner' | 'implementer'): RawCopilotCliContract {
  return {
    id: COPILOT_ID,
    command: COPILOT_COMMAND,
    role,
    versionArgs: COPILOT_VERSION_ARGS,
    auth: { kind: 'env-or-native', env: ['GH_TOKEN', 'GITHUB_TOKEN'] },
    rawInvocation:
      role === 'planner'
        ? [
            '-p',
            CLI_PROMPT_SENTINEL,
            '--plan',
            '--allow-all-tools',
            '--no-ask-user',
            '--output-format',
            'json',
          ]
        : ['-p', CLI_PROMPT_SENTINEL, '--allow-all'],
    promptTransport: 'argv',
    expectedRawTerminal: 'process-exit',
    asOf: '2026-07-31',
  };
}

const plannerRawContract = rawContract('planner');
const implementerRawContract = rawContract('implementer');

export const CLI_CONFORMANCE_CANDIDATES: readonly CopilotCliConformanceCandidate[] = Object.freeze([
  Object.freeze({
    id: COPILOT_ID,
    role: 'planner',
    rawContract: plannerRawContract,
    contractSha256: contractSha256(plannerRawContract),
    adapter: copilotPlannerAdapter,
  }),
  Object.freeze({
    id: COPILOT_ID,
    role: 'implementer',
    rawContract: implementerRawContract,
    contractSha256: contractSha256(implementerRawContract),
    adapter: copilotImplementerAdapter,
  }),
]);
