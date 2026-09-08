import { toTokenDelta } from '../../calls/usage.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { validateCliArgs } from './validate-args.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { isRecord, optionalString } from '../../../utils/type-guards.js';
import { error } from '../../../utils/error.js';

const COMMAND_CODE_ID = 'command-code' as const;
const COMMAND_CODE_COMMAND = 'cmd' as const;
const COMMAND_CODE_PROMPT_TRANSPORT = Object.freeze({
  kind: 'argv',
  maxBytes: 120_000,
  placement: 'positional',
} as const);
const COMMAND_CODE_VERSION_ARGS = Object.freeze(['--version'] as const);

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
  '--effort',
  '--no-auto-update',
  '-v',
  '--version',
]);
export const COMMAND_CODE_PROTECTED_SHORT_VALUE_FLAGS = new Set(['-p', '-m', '-r']);

type CommandCodePlannerBuildInput = Parameters<CliPlannerAdapter<'command-code'>['buildArgs']>[0];
type CommandCodeImplementerBuildInput = Parameters<
  CliImplementerAdapter<'command-code'>['buildArgs']
>[0];
type CommandCodeTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function validateArgs(input: { invocationArgs: readonly string[]; baseArgs: readonly string[] }) {
  return validateCliArgs({
    ...input,
    protectedFlags: COMMAND_CODE_PROTECTED_FLAGS,
    protectedShortValueFlags: COMMAND_CODE_PROTECTED_SHORT_VALUE_FLAGS,
    promptTransport: 'argv',
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
    ...(input.mode === 'plan' ? ['--permission-mode', 'plan'] : ['--yolo']),
    ...(input.model === undefined ? [] : ['-m', input.model]),
    ...(input.effort === undefined ? [] : ['--effort', input.effort]),
    input.prompt,
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
    // `--permission-mode auto-accept` still prompts for every write and shell call in
    // `-p` mode (cmd 1.50.1 answers "requires permissions. Use --yolo"); `--yolo` is the
    // headless write flag.
    '--yolo',
    ...(input.model === undefined ? [] : ['-m', input.model]),
    ...(input.effort === undefined ? [] : ['--effort', input.effort]),
    input.prompt,
  ];
}

function createProbe() {
  return {
    version: {
      command: [COMMAND_CODE_COMMAND, ...COMMAND_CODE_VERSION_ARGS],
      cwd: 'neutral',
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
    auth: {
      command: [COMMAND_CODE_COMMAND, 'status', '--json'],
      cwd: 'neutral',
      timeoutMs: 5_000,
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

function protocolFailure(code: string, message: string): CommandCodeTerminalEvent {
  return {
    type: 'result',
    status: 'failed',
    text: '',
    usage: null,
    nativeSessionId: null,
    error: { code, message },
    partial: false,
  };
}

function malformedRecord(): CommandCodeTerminalEvent {
  return protocolFailure('malformed-command-code-record', 'Command Code record is malformed');
}

function parseEventRecord(record: Record<string, unknown>): readonly CliProtocolEvent[] {
  if (!isRecord(record.event)) return [];
  if (record.event.type !== 'tool_running') return [];
  const name = optionalString(record.event.toolName, { trim: true, nonEmpty: true });
  if (name === undefined) return [];
  const id = optionalString(record.event.toolCallId, { trim: true, nonEmpty: true });
  return [{ type: 'tool-use', id: id ?? null, name, input: {} }];
}

function parseResultRecord(record: Record<string, unknown>): readonly CliProtocolEvent[] {
  let usage: TokenDelta | null = null;
  if (record.usage !== undefined) {
    if (!isRecord(record.usage)) return [malformedRecord()];
    usage = toTokenDelta(record.usage);
    if (usage === null && Object.keys(record.usage).length > 0) return [malformedRecord()];
  }

  const events: CliProtocolEvent[] = [];
  const sessionId = optionalString(record.sessionId, { trim: true, nonEmpty: true });
  if (sessionId !== undefined) events.push({ type: 'session', nativeSessionId: sessionId });
  if (usage !== null) events.push({ type: 'usage', usage, semantics: 'final' });

  if (optionalString(record.subtype, { trim: true, nonEmpty: true }) !== 'success') {
    // A failed frame carries its reason in `error` as a plain string and omits
    // `stopReason` entirely, so `error` has to be read first or the real cause
    // ("Not authenticated…") is replaced by the generic fallback.
    const message =
      optionalString(record.error, { trim: true, nonEmpty: true }) ??
      optionalString(record.stopReason, { trim: true, nonEmpty: true }) ??
      optionalString(record.finalText, { trim: true, nonEmpty: true }) ??
      'Command Code result failed';
    events.push(protocolFailure('command-code-result-failed', message));
    return events;
  }

  events.push({
    type: 'result',
    status: 'completed',
    text: optionalString(record.finalText) ?? '',
    usage,
    nativeSessionId: sessionId ?? null,
    error: null,
    partial: false,
  });
  return events;
}

function parseCommandCodeRecord(record: Record<string, unknown>): readonly CliProtocolEvent[] {
  const type = optionalString(record.type, { trim: true, nonEmpty: true });
  if (type === undefined) return [malformedRecord()];

  switch (type) {
    case 'event':
      return parseEventRecord(record);
    case 'result':
      return parseResultRecord(record);
    default:
      return [
        {
          type: 'warning',
          code: 'unknown-command-code-record',
          message: 'Unknown Command Code record',
        },
      ];
  }
}

export function commandCodeProtocolEvents(line: string): readonly CliProtocolEvent[] {
  if (line.trim().length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [protocolFailure('malformed-command-code-json', 'Command Code emitted malformed JSON')];
  }
  if (!isRecord(value)) return [malformedRecord()];
  return parseCommandCodeRecord(value);
}

function commandCodeTerminal(input: {
  events: readonly CliProtocolEvent[];
}): CommandCodeTerminalEvent {
  const terminal = input.events.findLast(
    (event): event is CommandCodeTerminalEvent => event.type === 'result',
  );
  if (terminal === undefined) {
    throw error(
      'command-code-protocol-failure',
      'Command Code output ended without a terminal result',
    );
  }
  const session = input.events.findLast(
    (event): event is Extract<CliProtocolEvent, { type: 'session' }> => event.type === 'session',
  );
  const nativeSessionId = session === undefined ? null : session.nativeSessionId;
  return terminal.nativeSessionId === null && nativeSessionId !== null
    ? { ...terminal, nativeSessionId }
    : terminal;
}

export const commandCodePlannerAdapter = createCommandCodePlannerAdapter();
export const commandCodeImplementerAdapter = createCommandCodeImplementerAdapter();

export type RawCommandCodeCliContract = Readonly<{
  id: typeof COMMAND_CODE_ID;
  command: typeof COMMAND_CODE_COMMAND;
  role: 'planner' | 'implementer';
  versionArgs: readonly ['--version'];
  auth: Readonly<{ kind: 'none'; env: readonly [] }>;
  rawInvocation: readonly string[];
  promptTransport: 'argv';
  expectedRawTerminal: 'result';
  asOf: '2026-09-08';
}>;

export type CommandCodeCliConformanceCandidate = Readonly<{
  id: typeof COMMAND_CODE_ID;
  role: 'planner' | 'implementer';
  rawContract: RawCommandCodeCliContract;
  contractSha256: string;
  adapter: CliPlannerAdapter<'command-code'> | CliImplementerAdapter<'command-code'>;
}>;

function commandCodeRawContract(role: 'planner' | 'implementer'): RawCommandCodeCliContract {
  return {
    id: COMMAND_CODE_ID,
    command: COMMAND_CODE_COMMAND,
    role,
    versionArgs: COMMAND_CODE_VERSION_ARGS,
    // No API-key env var is documented, so there is no env credential to require, and
    // `none` keeps contract-harness-raw from invoking a `cmd auth` subcommand that does
    // not exist — `cmd status --json` is the real auth probe.
    auth: { kind: 'none', env: [] },
    rawInvocation: [
      '-p',
      '--output-format',
      'json',
      '--trust',
      '--skip-onboarding',
      '--no-auto-update',
      ...(role === 'planner' ? ['--permission-mode', 'plan'] : ['--yolo']),
      CLI_PROMPT_SENTINEL,
    ],
    promptTransport: 'argv',
    expectedRawTerminal: 'result',
    asOf: '2026-09-08',
  };
}

const commandCodePlannerRawContract = commandCodeRawContract('planner');
const commandCodeImplementerRawContract = commandCodeRawContract('implementer');

export const CLI_CONFORMANCE_CANDIDATES: readonly CommandCodeCliConformanceCandidate[] =
  Object.freeze([
    Object.freeze({
      id: COMMAND_CODE_ID,
      role: 'planner',
      rawContract: commandCodePlannerRawContract,
      contractSha256: contractSha256(commandCodePlannerRawContract),
      adapter: commandCodePlannerAdapter,
    }),
    Object.freeze({
      id: COMMAND_CODE_ID,
      role: 'implementer',
      rawContract: commandCodeImplementerRawContract,
      contractSha256: contractSha256(commandCodeImplementerRawContract),
      adapter: commandCodeImplementerAdapter,
    }),
  ]);
