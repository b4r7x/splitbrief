import { createHash } from 'node:crypto';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { accumulateTokenUsage } from '../../calls/usage.js';
import type { ParsedLine } from '../types.js';
import { parseOpencodeLine } from '../../streaming/parse-opencode.js';
import { parseTextLine } from '../../streaming/parse-text.js';
import { isRecord } from '../../../utils/type-guards.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';

const KILO_ID = 'kilo-code' as const;
const KILO_COMMAND = 'kilo' as const;
const PROMPT_PLACEHOLDER = '<PROMPT>' as const;
const KILO_PROMPT_TRANSPORT = Object.freeze({ kind: 'argv', maxBytes: 120_000 } as const);
const KILO_VERSION_ARGS = Object.freeze(['--version'] as const);

const KILO_PROTECTED_FLAGS = new Set([
  '--agent',
  '--auto',
  '--format',
  '--model',
  '--output-format',
  '--prompt',
  'architect',
  'run',
]);

type KiloPlannerBuildInput = Parameters<CliPlannerAdapter<'kilo-code'>['buildArgs']>[0];
type KiloImplementerBuildInput = Parameters<CliImplementerAdapter<'kilo-code'>['buildArgs']>[0];
type KiloTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function promptPlaceholderConflict(value: string): boolean {
  return value.includes(PROMPT_PLACEHOLDER) || /^<[^>]+>$/.test(value) || /\{prompt\}/i.test(value);
}

function protectedFlag(value: string): string | null {
  if (KILO_PROTECTED_FLAGS.has(value)) return value;
  if (!value.startsWith('-')) return null;
  const flag = value.split('=', 1)[0] ?? value;
  return KILO_PROTECTED_FLAGS.has(flag) ? flag : null;
}

function validateArgs(
  invocationArgs: readonly string[],
  baseArgs: readonly string[] | null,
): Readonly<{ valid: true }> | Readonly<{ valid: false; conflicts: readonly string[] }> {
  if (baseArgs === null) return { valid: false, conflicts: ['adapter-build-order'] };

  const conflicts: string[] = [];
  const orderConflict =
    invocationArgs.length < baseArgs.length ||
    baseArgs.some((arg, index) => invocationArgs[index] !== arg);
  if (orderConflict) conflicts.push('argument-order');

  const promptCount = invocationArgs.filter((arg) => arg === PROMPT_PLACEHOLDER).length;
  if (promptCount !== 1) conflicts.push('prompt-transport');
  if (invocationArgs.some((arg) => arg !== PROMPT_PLACEHOLDER && promptPlaceholderConflict(arg))) {
    conflicts.push('prompt-transport');
  }

  if (!orderConflict) {
    for (const arg of invocationArgs.slice(baseArgs.length)) {
      const flag = protectedFlag(arg);
      if (flag) conflicts.push(flag);
    }
  }

  const uniqueConflicts = [...new Set(conflicts)];
  return uniqueConflicts.length === 0
    ? { valid: true }
    : { valid: false, conflicts: uniqueConflicts };
}

function structuredEvents(parsed: ParsedLine): readonly CliProtocolEvent[] {
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

function structuredErrorEnvelope(line: string): readonly CliProtocolEvent[] | null {
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
      error: { code: 'kilo-code-error', message: 'Kilo Code reported an error' },
      partial: true,
    },
  ];
}

export function kiloPlannerProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return structuredErrorEnvelope(line) ?? structuredEvents(parseOpencodeLine(line));
}

function textEvents(parsed: ParsedLine): readonly CliProtocolEvent[] {
  const events: CliProtocolEvent[] = [];
  if (parsed.text !== undefined && parsed.text.length > 0) {
    events.push({
      type: 'text',
      channel: parsed.channel ?? 'stdout',
      text: parsed.text,
    });
  }
  if (parsed.usage !== undefined) {
    events.push({
      type: 'usage',
      usage: parsed.usage,
      semantics: parsed.usageSemantics ?? 'final',
    });
  }
  for (const warning of parsed.warning ?? []) {
    events.push({ type: 'warning', code: warning.code, message: warning.message });
  }
  return events;
}

export function kiloImplementerProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return textEvents(parseTextLine(line));
}

export function kiloProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return kiloPlannerProtocolEvents(line);
}

function terminal(input: { events: readonly CliProtocolEvent[] }): KiloTerminalEvent {
  const explicit = input.events.findLast(
    (event): event is KiloTerminalEvent => event.type === 'result',
  );
  if (explicit !== undefined) return explicit;

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

function plannerBaseArgs(input: KiloPlannerBuildInput): string[] {
  return [
    'run',
    ...(input.model === undefined ? [] : ['--model', input.model]),
    '--format',
    'json',
    '--agent',
    'architect',
    input.prompt,
  ];
}

function implementerBaseArgs(input: KiloImplementerBuildInput): string[] {
  return [
    'run',
    ...(input.model === undefined ? [] : ['--model', input.model]),
    '--auto',
    input.prompt,
  ];
}

function createProbe() {
  return {
    version: {
      command: [KILO_COMMAND, ...KILO_VERSION_ARGS] as const,
      cwd: 'neutral' as const,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
    auth: {
      command: [KILO_COMMAND, 'auth'] as const,
      cwd: 'neutral' as const,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
  } as const;
}

function createPlannerAdapter(): CliPlannerAdapter<'kilo-code'> {
  let baseArgs: readonly string[] | null = null;
  return {
    descriptor: CLI_TOOL_CATALOG[KILO_ID],
    role: 'planner',
    promptTransport: KILO_PROMPT_TRANSPORT,
    buildArgs: (input) => {
      const args = plannerBaseArgs(input);
      baseArgs = args;
      return [...args, ...input.configuredArgs];
    },
    validateArgs: (invocationArgs) => validateArgs(invocationArgs, baseArgs),
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: kiloPlannerProtocolEvents,
    terminal,
    probe: createProbe(),
  };
}

function createImplementerAdapter(): CliImplementerAdapter<'kilo-code'> {
  let baseArgs: readonly string[] | null = null;
  return {
    descriptor: CLI_TOOL_CATALOG[KILO_ID],
    role: 'implementer',
    promptTransport: KILO_PROMPT_TRANSPORT,
    buildArgs: (input) => {
      const args = implementerBaseArgs(input);
      baseArgs = args;
      return [...args, ...input.configuredArgs];
    },
    validateArgs: (invocationArgs) => validateArgs(invocationArgs, baseArgs),
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: kiloImplementerProtocolEvents,
    terminal,
    probe: createProbe(),
  };
}

export const kiloPlannerAdapter = createPlannerAdapter();
export const kiloImplementerAdapter = createImplementerAdapter();

export type RawKiloCliContract = Readonly<{
  id: typeof KILO_ID;
  command: typeof KILO_COMMAND;
  role: 'planner' | 'implementer';
  versionArgs: readonly ['--version'];
  auth: Readonly<{ kind: 'env-or-native'; env: readonly [] }>;
  rawInvocation: readonly string[];
  promptTransport: 'argv';
  expectedRawTerminal: 'process-exit';
  asOf: '2026-07-31';
}>;

export type KiloCliConformanceCandidate = Readonly<{
  id: typeof KILO_ID;
  role: 'planner' | 'implementer';
  rawContract: RawKiloCliContract;
  contractSha256: string;
  adapter: CliPlannerAdapter<'kilo-code'> | CliImplementerAdapter<'kilo-code'>;
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

function contractHash(contract: RawKiloCliContract): string {
  return createHash('sha256').update(canonicalJson(contract), 'utf8').digest('hex');
}

function rawContract(role: 'planner' | 'implementer'): RawKiloCliContract {
  return {
    id: KILO_ID,
    command: KILO_COMMAND,
    role,
    versionArgs: KILO_VERSION_ARGS,
    auth: { kind: 'env-or-native', env: [] },
    rawInvocation:
      role === 'planner'
        ? ['run', '--format', 'json', '--agent', 'architect', PROMPT_PLACEHOLDER]
        : ['run', '--auto', PROMPT_PLACEHOLDER],
    promptTransport: 'argv',
    expectedRawTerminal: 'process-exit',
    asOf: '2026-07-31',
  };
}

const plannerRawContract = rawContract('planner');
const implementerRawContract = rawContract('implementer');

export const CLI_CONFORMANCE_CANDIDATES: readonly KiloCliConformanceCandidate[] = Object.freeze([
  Object.freeze({
    id: KILO_ID,
    role: 'planner',
    rawContract: plannerRawContract,
    contractSha256: contractHash(plannerRawContract),
    adapter: kiloPlannerAdapter,
  }),
  Object.freeze({
    id: KILO_ID,
    role: 'implementer',
    rawContract: implementerRawContract,
    contractSha256: contractHash(implementerRawContract),
    adapter: kiloImplementerAdapter,
  }),
]);

export function kiloPromptArgs(opts: {
  role: 'planner' | 'implementer';
  model?: string | undefined;
  projectDir?: string | undefined;
  mode?: 'plan' | 'escalate' | undefined;
  configuredArgs?: readonly string[] | undefined;
}): readonly string[] {
  const configuredArgs = opts.configuredArgs ?? [];
  if (opts.role === 'planner') {
    return kiloPlannerAdapter.buildArgs({
      prompt: PROMPT_PLACEHOLDER,
      model: opts.model,
      projectDir: opts.projectDir ?? '',
      configuredArgs,
      mode: opts.mode ?? 'plan',
      sessionId: null,
      effort: undefined,
    });
  }
  return kiloImplementerAdapter.buildArgs({
    prompt: PROMPT_PLACEHOLDER,
    model: opts.model,
    projectDir: opts.projectDir ?? '',
    configuredArgs,
  });
}
