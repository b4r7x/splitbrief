import { toTokenDelta } from '../../calls/usage.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { lastMessageGroupText } from './final-group.js';
import { validateCliArgs } from './validate-args.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { isRecord, optionalString } from '../../../utils/type-guards.js';
import { error } from '../../../utils/error.js';

const CODEX_ID = 'codex' as const;
const CODEX_COMMAND = 'codex' as const;
const CODEX_PROMPT_TRANSPORT = Object.freeze({ kind: 'stdin' } as const);
// `-` is the PROMPT value that both `exec` and `exec resume` document as "read from stdin".
// An omitted PROMPT also reads stdin, but prints `Reading prompt from stdin...` on stderr.
const CODEX_STDIN_PROMPT = '-';
const CODEX_VERSION_ARGS = Object.freeze(['--version'] as const);

// The refreshed call may refresh over the network when stale; the probe timeout and remembered
// catalog cover a cold miss. With no `auth.json` it exits 0 with the bundled list, which parses the
// same; a credential-less session channel stops first as `missing-credential`, so only an
// `authChannel: undefined` context gets it.
export const CODEX_NATIVE_MODEL_CATALOG_PROBE = Object.freeze({
  capability: 'debug-models-v2',
  command: Object.freeze([CODEX_COMMAND, 'debug', 'models'] as const),
  timeoutMs: 5_000,
  maxOutputBytes: 2 * 1024 * 1024,
});

const CODEX_PROTECTED_FLAGS = new Set([
  '--add-dir',
  '--approve-for-me',
  '--ask-for-approval',
  '--cd',
  '--config',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--ephemeral',
  '--ignore-rules',
  '--ignore-user-config',
  '--json',
  '--model',
  '--output-last-message',
  '--sandbox',
  '--skip-git-repo-check',
  '--yolo',
  '-a',
  '-C',
  '-c',
  '-s',
  'exec',
  'resume',
  'workspace-write',
]);
const CODEX_PROTECTED_SHORT_VALUE_FLAGS = new Set(['-a', '-C', '-c', '-s']);

type CodexPlannerBuildInput = Parameters<CliPlannerAdapter<'codex'>['buildArgs']>[0];
type CodexImplementerBuildInput = Parameters<CliImplementerAdapter<'codex'>['buildArgs']>[0];
type CodexTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function validateArgs(input: { invocationArgs: readonly string[]; baseArgs: readonly string[] }) {
  return validateCliArgs({
    ...input,
    protectedFlags: CODEX_PROTECTED_FLAGS,
    protectedShortValueFlags: CODEX_PROTECTED_SHORT_VALUE_FLAGS,
    promptTransport: 'stdin',
  });
}

/**
 * REQ-017 read-only planner vector for Codex 0.147.0. Sandbox and approval are
 * GLOBAL flags in v0.147 and must precede `exec`; `exec resume` does not accept
 * local `--sandbox`/`--ask-for-approval`. Ambient user config and AGENTS.md
 * rules are adapter-owned inputs the planner ignores. A fresh exec is
 * `--ephemeral` only when it is one-shot, so a review, a hint or an escalation
 * leaves no rollout in the codex home: a planning call is not, because the
 * planner resumes the thread it reports and `exec resume` finds no rollout for
 * an ephemeral one. The escalated planner row keeps its tier-2 workspace-write
 * within the staged project under the same never-approval policy.
 */
function plannerBaseArgs(input: CodexPlannerBuildInput): string[] {
  if (input.sessionId !== null && input.mode === 'plan') {
    return [
      ...(input.effort === undefined ? [] : ['-c', `model_reasoning_effort=${input.effort}`]),
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      'exec',
      'resume',
      ...(input.model === undefined ? [] : ['--model', input.model]),
      '--ignore-user-config',
      '--ignore-rules',
      '--json',
      input.sessionId,
      CODEX_STDIN_PROMPT,
    ];
  }

  const escalate = input.mode === 'escalate';
  return [
    ...(input.model === undefined ? [] : ['--model', input.model]),
    ...(input.effort === undefined ? [] : ['-c', `model_reasoning_effort=${input.effort}`]),
    '--sandbox',
    escalate ? 'workspace-write' : 'read-only',
    '--ask-for-approval',
    'never',
    'exec',
    '--ignore-user-config',
    ...(escalate ? [] : ['--ignore-rules']),
    ...(input.oneShot === true ? ['--ephemeral'] : []),
    '--json',
    ...(escalate ? ['--skip-git-repo-check'] : []),
    '--cd',
    input.projectDir,
    CODEX_STDIN_PROMPT,
  ];
}

/**
 * REQ-048 implementer vector: global workspace-write + never approval inside
 * the disposable staged checkout; no added roots, the reasoning effort as the
 * only config override, exact staged `--cd`.
 */
function implementerBaseArgs(input: CodexImplementerBuildInput): string[] {
  return [
    ...(input.model === undefined ? [] : ['--model', input.model]),
    ...(input.effort === undefined ? [] : ['-c', `model_reasoning_effort=${input.effort}`]),
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'never',
    'exec',
    '--ignore-user-config',
    '--json',
    '--skip-git-repo-check',
    '--cd',
    input.projectDir,
    CODEX_STDIN_PROMPT,
  ];
}

function createCodexPlannerAdapter(): CliPlannerAdapter<'codex'> {
  return {
    descriptor: CLI_TOOL_CATALOG.codex,
    role: 'planner',
    supportsSessionResume: true,
    supportsEffort: CLI_TOOL_CATALOG.codex.supportsEffort,
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

const CODEX_ITEM_INPUT_FIELDS = ['command', 'cwd', 'changes'] as const;

function codexToolEvent(
  item: Record<string, unknown>,
  terminal: 'started' | 'completed',
): CliProtocolEvent | null {
  const itemType = optionalString(item.type, { trim: true, nonEmpty: true });
  if (!itemType || itemType === 'agent_message') return null;
  // A command or a file change carries its input on the item itself, not under `input`.
  const input = isRecord(item.input)
    ? { ...item.input }
    : isRecord(item.arguments)
      ? { ...item.arguments }
      : Object.fromEntries(
          CODEX_ITEM_INPUT_FIELDS.flatMap((field) =>
            item[field] === undefined ? [] : [[field, item[field]] as const],
          ),
        );
  const id = optionalString(item.id ?? item.item_id ?? item.call_id, {
    trim: true,
    nonEmpty: true,
  });
  if (terminal === 'started') {
    return { type: 'tool-use', stage: 'started', id: id ?? null, name: itemType, input };
  }
  const output = item.output ?? item.result ?? item.text ?? item.content ?? item.status;
  return {
    type: 'tool-use',
    id: id ?? null,
    name: itemType,
    input,
    ...(output !== undefined ? { output } : {}),
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

export const codexPlannerAdapter = createCodexPlannerAdapter();
export const codexImplementerAdapter = createCodexImplementerAdapter();

export type RawCodexCliContract = Readonly<{
  id: typeof CODEX_ID;
  command: typeof CODEX_COMMAND;
  role: 'planner' | 'implementer';
  versionArgs: readonly ['--version'];
  auth: Readonly<{ kind: 'env-or-native'; env: readonly ['OPENAI_API_KEY'] }>;
  rawInvocation: readonly string[];
  promptTransport: 'stdin';
  expectedRawTerminal: 'turn.completed';
  asOf: '2026-09-29';
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
        ? [
            '--sandbox',
            'read-only',
            '--ask-for-approval',
            'never',
            'exec',
            '--ignore-user-config',
            '--ignore-rules',
            '--json',
            '--cd',
            '.',
            CODEX_STDIN_PROMPT,
          ]
        : [
            '--sandbox',
            'workspace-write',
            '--ask-for-approval',
            'never',
            'exec',
            '--ignore-user-config',
            '--json',
            '--skip-git-repo-check',
            '--cd',
            '.',
            CODEX_STDIN_PROMPT,
          ],
    promptTransport: 'stdin',
    expectedRawTerminal: 'turn.completed',
    asOf: '2026-09-29',
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
