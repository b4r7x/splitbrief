import { createHash } from 'node:crypto';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { parseStreamLine } from '../../streaming/parse-stream-json.js';
import { isRecord } from '../../../utils/type-guards.js';
import { error } from '../../../utils/error.js';

const CLAUDE_COMMAND = 'claude' as const;
const CLAUDE_ID = 'claude-code' as const;
const CLAUDE_PROMPT_TRANSPORT = Object.freeze({ kind: 'stdin' } as const);
const CLAUDE_BASE_ARGS = Object.freeze([
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
] as const);
const CLAUDE_PROTECTED_FLAGS = new Set([
  '-p',
  '--output-format',
  '--verbose',
  '--include-partial-messages',
  '--model',
  '--effort',
  '--permission-mode',
  '--session-id',
  '--resume',
  '--stream-json',
  '--terminal-event',
]);

type ClaudeBuildCommon = Readonly<{
  model: string | undefined;
  effort: EffortLevel | undefined;
  configuredArgs: readonly string[];
}>;

type ClaudePlannerBuild = ClaudeBuildCommon &
  Readonly<{
    prompt: string;
    projectDir: string;
    mode: 'plan' | 'escalate';
    sessionId: string | null;
  }>;

type ClaudeImplementerBuild = Readonly<{
  prompt: string;
  model: string | undefined;
  projectDir: string;
  configuredArgs: readonly string[];
}>;

function buildBaseArgs(opts: ClaudeBuildCommon): string[] {
  const args: string[] = [...CLAUDE_BASE_ARGS];
  if (opts.model !== undefined) args.push('--model', opts.model);
  if (opts.effort !== undefined) args.push('--effort', opts.effort);
  return args;
}

function buildPlannerArgs(opts: ClaudePlannerBuild): string[] {
  const args = buildBaseArgs(opts);
  if (opts.sessionId !== null) args.push('--session-id', opts.sessionId);
  return [...args, ...opts.configuredArgs];
}

function buildImplementerArgs(opts: ClaudeImplementerBuild): string[] {
  return [
    ...buildBaseArgs({ model: opts.model, effort: undefined, configuredArgs: opts.configuredArgs }),
    '--permission-mode',
    'acceptEdits',
    ...opts.configuredArgs,
  ];
}

function hasPromptPlaceholder(value: string): boolean {
  return value.includes('<PROMPT>') || /\{prompt\}/i.test(value) || /^<[^>]+>$/.test(value);
}

function validateArgs(
  invocationArgs: readonly string[],
  baseArgs: readonly string[] | null,
): Readonly<{ valid: true }> | Readonly<{ valid: false; conflicts: readonly string[] }> {
  if (baseArgs === null) return { valid: false, conflicts: ['adapter-build-order'] };
  const conflicts: string[] = [];
  if (
    invocationArgs.length < baseArgs.length ||
    baseArgs.some((arg, index) => invocationArgs[index] !== arg)
  ) {
    conflicts.push('argument-order');
  }
  const configuredArgs = invocationArgs.slice(baseArgs.length);
  for (const arg of configuredArgs) {
    if (hasPromptPlaceholder(arg)) conflicts.push('prompt-transport');
    if (arg.startsWith('-')) {
      const flag = arg.split('=', 1)[0] ?? arg;
      if (CLAUDE_PROTECTED_FLAGS.has(flag)) conflicts.push(flag);
    }
  }
  const uniqueConflicts = [...new Set(conflicts)];
  return uniqueConflicts.length === 0
    ? { valid: true }
    : { valid: false, conflicts: uniqueConflicts };
}

function toProtocolEvents(line: string): readonly CliProtocolEvent[] {
  const parsed = parseStreamLine(line);
  const events: CliProtocolEvent[] = [];
  if (parsed.sessionId !== undefined) {
    events.push({ type: 'session', nativeSessionId: parsed.sessionId });
  }
  if (parsed.text !== undefined && !parsed.isResult && parsed.text.length > 0) {
    events.push({ type: 'text', channel: parsed.channel ?? 'assistant', text: parsed.text });
  }
  if (parsed.usage !== undefined) {
    events.push({
      type: 'usage',
      usage: parsed.usage,
      semantics: parsed.usageSemantics ?? (parsed.isResult ? 'final' : 'delta'),
    });
  }
  for (const toolUse of [...(parsed.toolUse ?? [])]) {
    events.push({
      type: 'tool-use',
      id: toolUse.id ?? null,
      name: toolUse.name,
      input: { ...toolUse.input },
    });
  }
  for (const warning of parsed.warning ?? []) {
    events.push({ type: 'warning', code: warning.code, message: warning.message });
  }
  if (parsed.isResult) {
    const isError = parsed.isError === true;
    if (isError) {
      events.push({
        type: 'result',
        status: 'failed',
        text: parsed.text ?? '',
        usage: parsed.usage ?? null,
        nativeSessionId: parsed.sessionId ?? null,
        error: { code: 'runner_result_error', message: parsed.text ?? 'Claude result failed' },
        partial: true,
      });
    } else {
      events.push({
        type: 'result',
        status: 'completed',
        text: parsed.text ?? '',
        usage: parsed.usage ?? null,
        nativeSessionId: parsed.sessionId ?? null,
        error: null,
        partial: false,
      });
    }
  }
  return events;
}

function createProbe() {
  return {
    version: {
      command: [CLAUDE_COMMAND, '--version'] as const,
      cwd: 'neutral' as const,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
    auth: {
      command: [CLAUDE_COMMAND, 'auth'] as const,
      cwd: 'neutral' as const,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
  } as const;
}

function createAdapter(role: 'planner'): CliPlannerAdapter<'claude-code'>;
function createAdapter(role: 'implementer'): CliImplementerAdapter<'claude-code'>;
function createAdapter(
  role: 'planner' | 'implementer',
): CliPlannerAdapter<'claude-code'> | CliImplementerAdapter<'claude-code'> {
  let baseArgs: readonly string[] | null = null;
  const shared = {
    descriptor: CLI_TOOL_CATALOG[CLAUDE_ID],
    role,
    promptTransport: CLAUDE_PROMPT_TRANSPORT,
    validateArgs: (invocationArgs: readonly string[]) => validateArgs(invocationArgs, baseArgs),
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' } as const,
    parse: toProtocolEvents,
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
      buildArgs: (input) => {
        const built = buildPlannerArgs(input);
        baseArgs = built.slice(0, built.length - input.configuredArgs.length);
        return built;
      },
    } satisfies CliPlannerAdapter<'claude-code'>;
  }

  return {
    ...shared,
    role,
    buildArgs: (input) => {
      const built = buildImplementerArgs(input);
      baseArgs = built.slice(0, built.length - input.configuredArgs.length);
      return built;
    },
  } satisfies CliImplementerAdapter<'claude-code'>;
}

export const claudeCodePlannerAdapter = createAdapter('planner');
export const claudeCodeImplementerAdapter = createAdapter('implementer');

export type RawClaudeCliContract = Readonly<{
  id: typeof CLAUDE_ID;
  command: typeof CLAUDE_COMMAND;
  role: 'planner' | 'implementer';
  versionArgs: readonly ['--version'];
  auth: Readonly<{ kind: 'env-or-native'; env: readonly ['ANTHROPIC_API_KEY'] }>;
  rawInvocation: readonly string[];
  promptTransport: 'stdin';
  expectedRawTerminal: 'result';
  asOf: '2026-07-31';
}>;

export type ClaudeCliConformanceCandidate = Readonly<{
  id: typeof CLAUDE_ID;
  role: 'planner' | 'implementer';
  rawContract: RawClaudeCliContract;
  contractSha256: string;
  adapter: CliPlannerAdapter<'claude-code'> | CliImplementerAdapter<'claude-code'>;
}>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    if (!isRecord(value)) return JSON.stringify(value);
    const record = value;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function contractHash(contract: RawClaudeCliContract): string {
  return createHash('sha256').update(canonicalJson(contract), 'utf8').digest('hex');
}

function rawContract(role: 'planner' | 'implementer'): RawClaudeCliContract {
  return {
    id: CLAUDE_ID,
    command: CLAUDE_COMMAND,
    role,
    versionArgs: ['--version'],
    auth: { kind: 'env-or-native', env: ['ANTHROPIC_API_KEY'] },
    rawInvocation:
      role === 'planner'
        ? [...CLAUDE_BASE_ARGS]
        : [...CLAUDE_BASE_ARGS, '--permission-mode', 'acceptEdits'],
    promptTransport: 'stdin',
    expectedRawTerminal: 'result',
    asOf: '2026-07-31',
  };
}

const plannerRawContract = rawContract('planner');
const implementerRawContract = rawContract('implementer');

export const CLI_CONFORMANCE_CANDIDATES: readonly ClaudeCliConformanceCandidate[] = Object.freeze([
  Object.freeze({
    id: CLAUDE_ID,
    role: 'planner',
    rawContract: plannerRawContract,
    contractSha256: contractHash(plannerRawContract),
    adapter: claudeCodePlannerAdapter,
  }),
  Object.freeze({
    id: CLAUDE_ID,
    role: 'implementer',
    rawContract: implementerRawContract,
    contractSha256: contractHash(implementerRawContract),
    adapter: claudeCodeImplementerAdapter,
  }),
]);

export function claudeProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return toProtocolEvents(line);
}

export function claudePromptArgs(opts: {
  role: 'planner' | 'implementer';
  model?: string | undefined;
  effort?: EffortLevel | undefined;
  sessionId?: string | null | undefined;
  configuredArgs?: readonly string[] | undefined;
}): readonly string[] {
  const configuredArgs = opts.configuredArgs ?? [];
  if (opts.role === 'planner') {
    return buildPlannerArgs({
      prompt: '',
      projectDir: '',
      mode: 'plan',
      sessionId: opts.sessionId ?? null,
      model: opts.model,
      effort: opts.effort,
      configuredArgs,
    });
  }
  return buildImplementerArgs({
    prompt: '',
    projectDir: '',
    model: opts.model,
    configuredArgs,
  });
}
