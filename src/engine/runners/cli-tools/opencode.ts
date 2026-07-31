import { createHash } from 'node:crypto';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { accumulateTokenUsage } from '../../calls/usage.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { parseOpencodeLine } from '../../streaming/parse-opencode.js';
import type { ParsedLine } from '../types.js';
import { isRecord } from '../../../utils/type-guards.js';

const OPENCODE_ID = 'opencode' as const;
const OPENCODE_COMMAND = 'opencode' as const;
const PROMPT_PLACEHOLDER = '<PROMPT>' as const;
const OPENCODE_PROMPT_TRANSPORT = Object.freeze({ kind: 'argv', maxBytes: 120_000 } as const);
const OPENCODE_VERSION_ARGS = Object.freeze(['--version'] as const);

const OPENCODE_PROTECTED_FLAGS = new Set([
  '--agent',
  '--format',
  '--model',
  '--prompt',
  'plan',
  'run',
]);

type OpenCodeTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function promptPlaceholderConflict(value: string): boolean {
  return value.includes(PROMPT_PLACEHOLDER) || /^<[^>]+>$/.test(value) || /\{prompt\}/i.test(value);
}

function protectedFlag(value: string): string | null {
  if (OPENCODE_PROTECTED_FLAGS.has(value)) return value;
  if (!value.startsWith('-')) return null;
  const flag = value.split('=', 1)[0] ?? value;
  return OPENCODE_PROTECTED_FLAGS.has(flag) ? flag : null;
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

  const promptCount = invocationArgs.filter((arg) => arg === PROMPT_PLACEHOLDER).length;
  if (promptCount !== 1) conflicts.push('prompt-transport');
  if (invocationArgs.some((arg) => arg !== PROMPT_PLACEHOLDER && promptPlaceholderConflict(arg))) {
    conflicts.push('prompt-transport');
  }

  for (const arg of invocationArgs.slice(baseArgs.length)) {
    const flag = protectedFlag(arg);
    if (flag) conflicts.push(flag);
  }

  const uniqueConflicts = [...new Set(conflicts)];
  return uniqueConflicts.length === 0
    ? { valid: true }
    : { valid: false, conflicts: uniqueConflicts };
}

function toProtocolEvents(parsed: ParsedLine): readonly CliProtocolEvent[] {
  const events: CliProtocolEvent[] = [];
  if (parsed.sessionId !== undefined) {
    events.push({ type: 'session', nativeSessionId: parsed.sessionId });
  }
  if (parsed.text !== undefined && parsed.text.length > 0) {
    events.push({
      type: 'text',
      channel: parsed.channel ?? 'assistant',
      text: parsed.text,
    });
  }
  if (parsed.usage !== undefined) {
    events.push({
      type: 'usage',
      usage: parsed.usage,
      semantics: parsed.usageSemantics ?? 'delta',
    });
  }
  for (const toolUse of [
    ...(parsed.toolUse ?? []),
    ...(parsed.toolUseStart ?? []),
    ...(parsed.toolUseDone ?? []),
  ]) {
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

function errorEnvelope(line: string): readonly CliProtocolEvent[] | null {
  let value: unknown;
  try {
    value = JSON.parse(line.trim());
  } catch {
    return null;
  }
  if (!isRecord(value) || value.type !== 'error') return null;
  const nativeSessionId =
    typeof value.sessionID === 'string'
      ? value.sessionID
      : typeof value.sessionId === 'string'
        ? value.sessionId
        : null;
  return [
    {
      type: 'result',
      status: 'failed',
      text: '',
      usage: null,
      nativeSessionId,
      error: { code: 'opencode-error', message: 'OpenCode reported an error' },
      partial: true,
    },
  ];
}

export function opencodeProtocolEvents(line: string): readonly CliProtocolEvent[] {
  const errorEvents = errorEnvelope(line);
  return errorEvents ?? toProtocolEvents(parseOpencodeLine(line));
}

function terminal(input: { events: readonly CliProtocolEvent[] }): OpenCodeTerminalEvent {
  const explicit = input.events.findLast(
    (event): event is OpenCodeTerminalEvent => event.type === 'result',
  );
  if (explicit !== undefined) return explicit;

  let usage = null;
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

function createProbe() {
  return {
    version: {
      command: [OPENCODE_COMMAND, ...OPENCODE_VERSION_ARGS] as const,
      cwd: 'neutral' as const,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
    auth: {
      command: [OPENCODE_COMMAND, 'auth'] as const,
      cwd: 'neutral' as const,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
  } as const;
}

function createPlannerAdapter(): CliPlannerAdapter<'opencode'> {
  let baseArgs: readonly string[] | null = null;
  return {
    descriptor: CLI_TOOL_CATALOG.opencode,
    role: 'planner',
    promptTransport: OPENCODE_PROMPT_TRANSPORT,
    buildArgs: (input) => {
      const args = ['run'];
      if (input.model !== undefined) args.push('--model', input.model);
      args.push('--format', 'json', '--agent', 'plan', input.prompt);
      baseArgs = args;
      return [...args, ...input.configuredArgs];
    },
    validateArgs: (invocationArgs) => validateArgs(invocationArgs, baseArgs),
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: opencodeProtocolEvents,
    terminal,
    probe: createProbe(),
  };
}

function createImplementerAdapter(): CliImplementerAdapter<'opencode'> {
  let baseArgs: readonly string[] | null = null;
  return {
    descriptor: CLI_TOOL_CATALOG.opencode,
    role: 'implementer',
    promptTransport: OPENCODE_PROMPT_TRANSPORT,
    buildArgs: (input) => {
      const args = ['run'];
      if (input.model !== undefined) args.push('--model', input.model);
      args.push('--format', 'json', input.prompt);
      baseArgs = args;
      return [...args, ...input.configuredArgs];
    },
    validateArgs: (invocationArgs) => validateArgs(invocationArgs, baseArgs),
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: opencodeProtocolEvents,
    terminal,
    probe: createProbe(),
  };
}

export const opencodePlannerAdapter = createPlannerAdapter();
export const opencodeImplementerAdapter = createImplementerAdapter();

export type RawOpenCodeCliContract = Readonly<{
  id: typeof OPENCODE_ID;
  command: typeof OPENCODE_COMMAND;
  role: 'planner' | 'implementer';
  versionArgs: readonly ['--version'];
  auth: Readonly<{ kind: 'env-or-native'; env: readonly [] }>;
  rawInvocation: readonly string[];
  promptTransport: 'argv';
  expectedRawTerminal: 'process-exit';
  asOf: '2026-07-31';
}>;

export type OpenCodeCliConformanceCandidate = Readonly<{
  id: typeof OPENCODE_ID;
  role: 'planner' | 'implementer';
  rawContract: RawOpenCodeCliContract;
  contractSha256: string;
  adapter: CliPlannerAdapter<'opencode'> | CliImplementerAdapter<'opencode'>;
}>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function contractHash(contract: RawOpenCodeCliContract): string {
  return createHash('sha256').update(canonicalJson(contract), 'utf8').digest('hex');
}

function rawContract(role: 'planner' | 'implementer'): RawOpenCodeCliContract {
  return {
    id: OPENCODE_ID,
    command: OPENCODE_COMMAND,
    role,
    versionArgs: OPENCODE_VERSION_ARGS,
    auth: { kind: 'env-or-native', env: [] },
    rawInvocation:
      role === 'planner'
        ? ['run', '--format', 'json', '--agent', 'plan', PROMPT_PLACEHOLDER]
        : ['run', '--format', 'json', PROMPT_PLACEHOLDER],
    promptTransport: 'argv',
    expectedRawTerminal: 'process-exit',
    asOf: '2026-07-31',
  };
}

const plannerRawContract = rawContract('planner');
const implementerRawContract = rawContract('implementer');

export const CLI_CONFORMANCE_CANDIDATES: readonly OpenCodeCliConformanceCandidate[] = Object.freeze(
  [
    Object.freeze({
      id: OPENCODE_ID,
      role: 'planner',
      rawContract: plannerRawContract,
      contractSha256: contractHash(plannerRawContract),
      adapter: opencodePlannerAdapter,
    }),
    Object.freeze({
      id: OPENCODE_ID,
      role: 'implementer',
      rawContract: implementerRawContract,
      contractSha256: contractHash(implementerRawContract),
      adapter: opencodeImplementerAdapter,
    }),
  ],
);

export function opencodePromptArgs(opts: {
  role: 'planner' | 'implementer';
  model?: string | undefined;
  configuredArgs?: readonly string[] | undefined;
}): readonly string[] {
  const configuredArgs = opts.configuredArgs ?? [];
  if (opts.role === 'planner') {
    return opencodePlannerAdapter.buildArgs({
      prompt: PROMPT_PLACEHOLDER,
      model: opts.model,
      projectDir: '',
      configuredArgs,
      mode: 'plan',
      sessionId: null,
      effort: undefined,
    });
  }
  return opencodeImplementerAdapter.buildArgs({
    prompt: PROMPT_PLACEHOLDER,
    model: opts.model,
    projectDir: '',
    configuredArgs,
  });
}
