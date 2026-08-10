import { toTokenDelta } from '../../calls/usage.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { validateCliArgs } from './validate-args.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { isRecord, optionalString } from '../../../utils/type-guards.js';
import { error } from '../../../utils/error.js';

const CODEX_ID = 'codex' as const;
const CODEX_COMMAND = 'codex' as const;
const CODEX_PROMPT_TRANSPORT = Object.freeze({
  kind: 'argv',
  maxBytes: 120_000,
  placement: 'positional',
} as const);
const CODEX_VERSION_ARGS = Object.freeze(['--version'] as const);

export const CODEX_NATIVE_MODEL_CATALOG_PROBE = Object.freeze({
  capability: 'debug-models-bundled-v1',
  command: Object.freeze([CODEX_COMMAND, 'debug', 'models', '--bundled'] as const),
  timeoutMs: 5_000,
  maxOutputBytes: 2 * 1024 * 1024,
});

const CODEX_PROTECTED_FLAGS = new Set([
  '--cd',
  '--json',
  '--model',
  '--sandbox',
  '--skip-git-repo-check',
  'exec',
  'resume',
  'workspace-write',
]);

type CodexPlannerBuildInput = Parameters<CliPlannerAdapter<'codex'>['buildArgs']>[0];
type CodexImplementerBuildInput = Parameters<CliImplementerAdapter<'codex'>['buildArgs']>[0];
type CodexTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function validateArgs(invocationArgs: readonly string[], baseArgs: readonly string[]) {
  return validateCliArgs({
    invocationArgs,
    baseArgs,
    protectedFlags: CODEX_PROTECTED_FLAGS,
    promptTransport: 'argv',
  });
}

function plannerBaseArgs(input: CodexPlannerBuildInput): string[] {
  if (input.sessionId !== null && input.mode === 'plan') {
    return [
      'exec',
      'resume',
      ...(input.model === undefined ? [] : ['--model', input.model]),
      '--json',
      input.sessionId,
      input.prompt,
    ];
  }

  return [
    ...(input.model === undefined ? [] : ['--model', input.model]),
    'exec',
    '--json',
    ...(input.mode === 'escalate' ? ['--sandbox', 'workspace-write', '--skip-git-repo-check'] : []),
    '--cd',
    input.projectDir,
    input.prompt,
  ];
}

function implementerBaseArgs(input: CodexImplementerBuildInput): string[] {
  return [
    ...(input.model === undefined ? [] : ['--model', input.model]),
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '--cd',
    input.projectDir,
    input.prompt,
  ];
}

function createCodexPlannerAdapter(): CliPlannerAdapter<'codex'> {
  return {
    descriptor: CLI_TOOL_CATALOG.codex,
    role: 'planner',
    supportsSessionResume: true,
    supportsEffort: false,
    promptTransport: CODEX_PROMPT_TRANSPORT,
    baseArgs: plannerBaseArgs,
    buildArgs: (input) => [...plannerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' },
    parse: codexProtocolEvents,
    terminal: codexTerminal,
    probe: {
      version: {
        command: [CODEX_COMMAND, ...CODEX_VERSION_ARGS],
        cwd: 'neutral',
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
      auth: {
        command: [CODEX_COMMAND, 'login', 'status'],
        cwd: 'neutral',
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    },
  };
}

function createCodexImplementerAdapter(): CliImplementerAdapter<'codex'> {
  return {
    descriptor: CLI_TOOL_CATALOG.codex,
    role: 'implementer',
    promptTransport: CODEX_PROMPT_TRANSPORT,
    baseArgs: implementerBaseArgs,
    buildArgs: (input) => [...implementerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' },
    parse: codexProtocolEvents,
    terminal: codexTerminal,
    probe: {
      version: {
        command: [CODEX_COMMAND, ...CODEX_VERSION_ARGS],
        cwd: 'neutral',
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
      auth: {
        command: [CODEX_COMMAND, 'login', 'status'],
        cwd: 'neutral',
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    },
  };
}

function protocolFailure(code: string, message: string): CodexTerminalEvent {
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

const CODEX_EMBEDDED_ERROR_MESSAGE_DEPTH = 4;

function codexEmbeddedErrorMessage(text: string): string {
  let current = text.trim();
  if (current.length === 0) return text;

  for (let depth = 0; depth < CODEX_EMBEDDED_ERROR_MESSAGE_DEPTH; depth++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      break;
    }
    if (!isRecord(parsed)) break;

    const nested = isRecord(parsed.error) ? parsed.error : undefined;
    const next =
      optionalString(nested?.message, { trim: true, nonEmpty: true }) ??
      (optionalString(parsed.type, { trim: true, nonEmpty: true }) === 'error'
        ? optionalString(parsed.message, { trim: true, nonEmpty: true })
        : undefined);
    if (next === undefined || next === current) break;
    current = next;
  }

  return current.length > 0 ? current : text;
}

function codexTurnFailedDetail(rawMessage: string | undefined): string {
  if (rawMessage === undefined) return 'Codex turn failed';
  const envelope = rawMessage.trim();
  if (envelope.length === 0) return 'Codex turn failed';
  const detail = codexEmbeddedErrorMessage(envelope);
  if (detail === envelope) return detail;
  return `${detail}\n${envelope}`;
}

function extractAgentText(item: Record<string, unknown>): string | null {
  if (typeof item.text === 'string') return item.text;
  if (!Array.isArray(item.content)) return item.content === undefined ? '' : null;

  const text = item.content
    .filter(isRecord)
    .filter((block) => block.type === 'text' || block.type === 'output_text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
  return text;
}

function codexToolEvent(
  item: Record<string, unknown>,
  terminal: 'started' | 'completed',
): CliProtocolEvent | null {
  const itemType = optionalString(item.type, { trim: true, nonEmpty: true });
  if (!itemType || itemType === 'agent_message') return null;
  const input = isRecord(item.input)
    ? { ...item.input }
    : isRecord(item.arguments)
      ? { ...item.arguments }
      : {};
  const id = optionalString(item.id ?? item.item_id ?? item.call_id, {
    trim: true,
    nonEmpty: true,
  });
  const output = item.output ?? item.result ?? item.text ?? item.content ?? item.status;
  return {
    type: 'tool-use',
    id: id ?? null,
    name: itemType,
    input,
    ...(terminal === 'completed' && output !== undefined ? { output } : {}),
  };
}

function parseCodexRecord(record: Record<string, unknown>): readonly CliProtocolEvent[] {
  const type = optionalString(record.type, { trim: true, nonEmpty: true });
  if (type === undefined)
    return [protocolFailure('malformed-codex-record', 'Codex record is malformed')];

  switch (type) {
    case 'thread.started': {
      const threadId = optionalString(record.thread_id, { trim: true, nonEmpty: true });
      return threadId === undefined
        ? [protocolFailure('malformed-codex-record', 'Codex thread record is malformed')]
        : [{ type: 'session', nativeSessionId: threadId }];
    }
    case 'item.started':
    case 'item.completed': {
      if (!isRecord(record.item)) {
        return [protocolFailure('malformed-codex-record', 'Codex item record is malformed')];
      }
      const itemType = optionalString(record.item.type, { trim: true, nonEmpty: true });
      if (itemType === undefined) {
        return [protocolFailure('malformed-codex-record', 'Codex item record is malformed')];
      }
      if (itemType === 'agent_message' && type === 'item.completed') {
        const text = extractAgentText(record.item);
        return text === null
          ? [protocolFailure('malformed-codex-record', 'Codex message record is malformed')]
          : text.length > 0
            ? [{ type: 'text', channel: 'assistant', text }]
            : [];
      }
      const tool = codexToolEvent(record.item, type === 'item.completed' ? 'completed' : 'started');
      return tool === null ? [] : [tool];
    }
    case 'item.updated':
    case 'turn.started':
      return [];
    case 'turn.completed': {
      const hasUsage = Object.hasOwn(record, 'usage');
      let usage: TokenDelta | null = null;
      if (hasUsage && record.usage !== undefined) {
        if (!isRecord(record.usage)) {
          return [protocolFailure('malformed-codex-record', 'Codex terminal record is malformed')];
        }
        usage = toTokenDelta(record.usage);
        if (usage === null && Object.keys(record.usage).length > 0) {
          return [protocolFailure('malformed-codex-record', 'Codex usage record is malformed')];
        }
      }
      const events: CliProtocolEvent[] = [];
      if (usage !== null) events.push({ type: 'usage', usage, semantics: 'final' });
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
    case 'turn.failed': {
      const rawMessage = isRecord(record.error)
        ? optionalString(record.error.message, { trim: true, nonEmpty: true })
        : undefined;
      return [protocolFailure('codex-turn-failed', codexTurnFailedDetail(rawMessage))];
    }
    case 'error': {
      const message = optionalString(record.message, { trim: true, nonEmpty: true });
      return [protocolFailure('codex-error', message ?? 'Codex reported an error')];
    }
    default:
      return [{ type: 'warning', code: 'unknown-codex-record', message: 'Unknown Codex record' }];
  }
}

export function codexProtocolEvents(line: string): readonly CliProtocolEvent[] {
  if (line.trim().length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [protocolFailure('malformed-codex-json', 'Codex emitted malformed JSON')];
  }
  if (!isRecord(value)) {
    return [protocolFailure('malformed-codex-record', 'Codex record is malformed')];
  }
  return parseCodexRecord(value);
}

function codexTerminal(input: { events: readonly CliProtocolEvent[] }): CodexTerminalEvent {
  const terminal = input.events.findLast(
    (event): event is CodexTerminalEvent => event.type === 'result',
  );
  if (terminal === undefined) {
    throw error('codex-protocol-failure', 'Codex output ended without a terminal result');
  }
  const session = input.events.findLast(
    (event): event is Extract<CliProtocolEvent, { type: 'session' }> => event.type === 'session',
  );
  if (session === undefined || terminal.nativeSessionId !== null) return terminal;
  return { ...terminal, nativeSessionId: session.nativeSessionId };
}

export const codexPlannerAdapter = createCodexPlannerAdapter();
export const codexImplementerAdapter = createCodexImplementerAdapter();

export type RawCodexCliContract = Readonly<{
  id: typeof CODEX_ID;
  command: typeof CODEX_COMMAND;
  role: 'planner' | 'implementer';
  versionArgs: readonly ['--version'];
  auth: Readonly<{ kind: 'env-or-native'; env: readonly ['OPENAI_API_KEY'] }>;
  rawInvocation: readonly string[];
  promptTransport: 'argv';
  expectedRawTerminal: 'turn.completed';
  asOf: '2026-07-31';
}>;

export type CodexCliConformanceCandidate = Readonly<{
  id: typeof CODEX_ID;
  role: 'planner' | 'implementer';
  rawContract: RawCodexCliContract;
  contractSha256: string;
  adapter: CliPlannerAdapter<'codex'> | CliImplementerAdapter<'codex'>;
}>;

function codexRawContract(role: 'planner' | 'implementer'): RawCodexCliContract {
  return {
    id: CODEX_ID,
    command: CODEX_COMMAND,
    role,
    versionArgs: CODEX_VERSION_ARGS,
    auth: { kind: 'env-or-native', env: ['OPENAI_API_KEY'] },
    rawInvocation:
      role === 'planner'
        ? ['exec', '--json', '--cd', '.', CLI_PROMPT_SENTINEL]
        : [
            'exec',
            '--json',
            '--sandbox',
            'workspace-write',
            '--skip-git-repo-check',
            '--cd',
            '.',
            CLI_PROMPT_SENTINEL,
          ],
    promptTransport: 'argv',
    expectedRawTerminal: 'turn.completed',
    asOf: '2026-07-31',
  };
}

const codexPlannerRawContract = codexRawContract('planner');
const codexImplementerRawContract = codexRawContract('implementer');

export const CLI_CONFORMANCE_CANDIDATES: readonly CodexCliConformanceCandidate[] = Object.freeze([
  Object.freeze({
    id: CODEX_ID,
    role: 'planner',
    rawContract: codexPlannerRawContract,
    contractSha256: contractSha256(codexPlannerRawContract),
    adapter: codexPlannerAdapter,
  }),
  Object.freeze({
    id: CODEX_ID,
    role: 'implementer',
    rawContract: codexImplementerRawContract,
    contractSha256: contractSha256(codexImplementerRawContract),
    adapter: codexImplementerAdapter,
  }),
]);
