import { toTokenDelta } from '../../calls/usage.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { lastMessageGroupText } from './final-group.js';
import { validateCliArgs } from './validate-args.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { isRecord, optionalString } from '../../../utils/type-guards.js';
import { error } from '../../../utils/error.js';

const CURSOR_ID = 'cursor' as const;
const CURSOR_COMMAND = 'cursor-agent' as const;
const CURSOR_PROMPT_TRANSPORT = Object.freeze({
  kind: 'argv',
  maxBytes: 120_000,
  placement: 'positional',
} as const);
const CURSOR_VERSION_ARGS = Object.freeze(['--version'] as const);

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
type CursorTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function validateArgs(input: { invocationArgs: readonly string[]; baseArgs: readonly string[] }) {
  return validateCliArgs({
    ...input,
    protectedFlags: CURSOR_PROTECTED_FLAGS,
    protectedShortValueFlags: CURSOR_PROTECTED_SHORT_VALUE_FLAGS,
    promptTransport: 'argv',
  });
}

function plannerBaseArgs(input: CursorPlannerBuildInput): string[] {
  return [
    '--print',
    '--output-format',
    'stream-json',
    ...(input.mode === 'plan' ? ['--mode', 'plan'] : ['--force']),
    '--trust',
    ...(input.model === undefined ? [] : ['--model', input.model]),
    input.prompt,
  ];
}

function implementerBaseArgs(input: CursorImplementerBuildInput): string[] {
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--force',
    '--trust',
    ...(input.model === undefined ? [] : ['--model', input.model]),
    input.prompt,
  ];
}

function createProbe() {
  return {
    version: {
      command: [CURSOR_COMMAND, ...CURSOR_VERSION_ARGS] as const,
      cwd: 'neutral' as const,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
    auth: {
      command: [CURSOR_COMMAND, 'status'] as const,
      cwd: 'neutral' as const,
      timeoutMs: 5_000,
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

function protocolFailure(code: string, message: string): CursorTerminalEvent {
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

function extractAssistantText(message: Record<string, unknown>): string | null {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return message.content === undefined ? '' : null;
  return message.content
    .filter(isRecord)
    .filter((block) => block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function parseCursorRecord(record: Record<string, unknown>): readonly CliProtocolEvent[] {
  const type = optionalString(record.type, { trim: true, nonEmpty: true });
  if (type === undefined) {
    return [protocolFailure('malformed-cursor-record', 'Cursor record is malformed')];
  }

  switch (type) {
    case 'system': {
      const sessionId = optionalString(record.session_id, { trim: true, nonEmpty: true });
      return sessionId === undefined ? [] : [{ type: 'session', nativeSessionId: sessionId }];
    }
    case 'user':
    case 'thinking':
      return [];
    case 'assistant': {
      if (!isRecord(record.message)) {
        return [protocolFailure('malformed-cursor-record', 'Cursor message record is malformed')];
      }
      const text = extractAssistantText(record.message);
      return text === null
        ? [protocolFailure('malformed-cursor-record', 'Cursor message record is malformed')]
        : text.length > 0
          ? [{ type: 'text', channel: 'assistant', text }]
          : [];
    }
    case 'result': {
      const hasUsage = Object.hasOwn(record, 'usage');
      let usage: TokenDelta | null = null;
      if (hasUsage && record.usage !== undefined) {
        if (!isRecord(record.usage)) {
          return [protocolFailure('malformed-cursor-record', 'Cursor usage record is malformed')];
        }
        usage = toTokenDelta(record.usage);
        if (usage === null && Object.keys(record.usage).length > 0) {
          return [protocolFailure('malformed-cursor-record', 'Cursor usage record is malformed')];
        }
      }
      const subtype = optionalString(record.subtype, { trim: true, nonEmpty: true });
      const failed = record.is_error === true || subtype !== 'success';
      const events: CliProtocolEvent[] = [];
      if (usage !== null) events.push({ type: 'usage', usage, semantics: 'final' });
      if (failed) {
        const message =
          optionalString(record.result, { trim: true, nonEmpty: true }) ?? 'Cursor result failed';
        events.push(protocolFailure('cursor-result-failed', message));
        return events;
      }
      events.push({
        type: 'result',
        status: 'completed',
        text: '',
        usage,
        nativeSessionId: null,
        error: null,
        partial: false,
      });
      return events;
    }
    default:
      return [{ type: 'warning', code: 'unknown-cursor-record', message: 'Unknown Cursor record' }];
  }
}

export function cursorProtocolEvents(line: string): readonly CliProtocolEvent[] {
  if (line.trim().length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [protocolFailure('malformed-cursor-json', 'Cursor emitted malformed JSON')];
  }
  if (!isRecord(value)) {
    return [protocolFailure('malformed-cursor-record', 'Cursor record is malformed')];
  }
  return parseCursorRecord(value);
}

function cursorTerminal(input: { events: readonly CliProtocolEvent[] }): CursorTerminalEvent {
  const terminal = input.events.findLast(
    (event): event is CursorTerminalEvent => event.type === 'result',
  );
  if (terminal === undefined) {
    throw error('cursor-protocol-failure', 'Cursor output ended without a terminal result');
  }
  const session = input.events.findLast(
    (event): event is Extract<CliProtocolEvent, { type: 'session' }> => event.type === 'session',
  );
  const nativeSessionId = session === undefined ? null : session.nativeSessionId;
  if (terminal.status !== 'completed') {
    return terminal.nativeSessionId === null && nativeSessionId !== null
      ? { ...terminal, nativeSessionId }
      : terminal;
  }
  return {
    ...terminal,
    text: lastMessageGroupText(input.events),
    ...(terminal.nativeSessionId === null && nativeSessionId !== null ? { nativeSessionId } : {}),
  };
}

export const cursorPlannerAdapter = createCursorPlannerAdapter();
export const cursorImplementerAdapter = createCursorImplementerAdapter();

export type RawCursorCliContract = Readonly<{
  id: typeof CURSOR_ID;
  command: typeof CURSOR_COMMAND;
  role: 'planner' | 'implementer';
  versionArgs: readonly ['--version'];
  auth: Readonly<{ kind: 'env-or-native'; env: readonly ['CURSOR_API_KEY'] }>;
  rawInvocation: readonly string[];
  promptTransport: 'argv';
  expectedRawTerminal: 'result';
  asOf: '2026-08-27';
}>;

export type CursorCliConformanceCandidate = Readonly<{
  id: typeof CURSOR_ID;
  role: 'planner' | 'implementer';
  rawContract: RawCursorCliContract;
  contractSha256: string;
  adapter: CliPlannerAdapter<'cursor'> | CliImplementerAdapter<'cursor'>;
}>;

function cursorRawContract(role: 'planner' | 'implementer'): RawCursorCliContract {
  return {
    id: CURSOR_ID,
    command: CURSOR_COMMAND,
    role,
    versionArgs: CURSOR_VERSION_ARGS,
    auth: { kind: 'env-or-native', env: ['CURSOR_API_KEY'] },
    rawInvocation:
      role === 'planner'
        ? [
            '--print',
            '--output-format',
            'stream-json',
            '--mode',
            'plan',
            '--trust',
            CLI_PROMPT_SENTINEL,
          ]
        : ['--print', '--output-format', 'stream-json', '--force', '--trust', CLI_PROMPT_SENTINEL],
    promptTransport: 'argv',
    expectedRawTerminal: 'result',
    asOf: '2026-08-27',
  };
}

const cursorPlannerRawContract = cursorRawContract('planner');
const cursorImplementerRawContract = cursorRawContract('implementer');

export const CLI_CONFORMANCE_CANDIDATES: readonly CursorCliConformanceCandidate[] = Object.freeze([
  Object.freeze({
    id: CURSOR_ID,
    role: 'planner',
    rawContract: cursorPlannerRawContract,
    contractSha256: contractSha256(cursorPlannerRawContract),
    adapter: cursorPlannerAdapter,
  }),
  Object.freeze({
    id: CURSOR_ID,
    role: 'implementer',
    rawContract: cursorImplementerRawContract,
    contractSha256: contractSha256(cursorImplementerRawContract),
    adapter: cursorImplementerAdapter,
  }),
]);
