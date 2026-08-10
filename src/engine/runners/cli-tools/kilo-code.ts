import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { accumulateTokenUsage } from '../../calls/usage.js';
import type { ParsedLine } from '../types.js';
import { envelopeErrorDetail } from '../../streaming/error-envelope.js';
import { parseOpencodeLine } from '../../streaming/parse-opencode.js';
import { parseTextLine } from '../../streaming/parse-text.js';
import { isRecord } from '../../../utils/type-guards.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { validateCliArgs } from './validate-args.js';

const KILO_ID = 'kilo-code' as const;
const KILO_COMMAND = 'kilo' as const;
const KILO_PROMPT_TRANSPORT = Object.freeze({
  kind: 'argv',
  maxBytes: 120_000,
  placement: 'positional',
} as const);
const KILO_VERSION_ARGS = Object.freeze(['--version'] as const);

const KILO_PROTECTED_FLAGS = new Set([
  '--agent',
  '--auto',
  '--format',
  '--model',
  '--output-format',
  '--prompt',
  '-m',
  'plan',
  'run',
]);
const KILO_PROTECTED_SHORT_VALUE_FLAGS = new Set(['-m']);

type KiloPlannerBuildInput = Parameters<CliPlannerAdapter<'kilo-code'>['buildArgs']>[0];
type KiloImplementerBuildInput = Parameters<CliImplementerAdapter<'kilo-code'>['buildArgs']>[0];
type KiloTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function validateArgs(invocationArgs: readonly string[], baseArgs: readonly string[]) {
  return validateCliArgs({
    invocationArgs,
    baseArgs,
    protectedFlags: KILO_PROTECTED_FLAGS,
    protectedShortValueFlags: KILO_PROTECTED_SHORT_VALUE_FLAGS,
    promptTransport: 'argv',
  });
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
      error: {
        code: 'kilo-code-error',
        message: envelopeErrorDetail(value, 'Kilo Code reported an error'),
      },
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
    ...(input.mode === 'plan' ? ['--agent', 'plan'] : ['--agent', 'code', '--auto']),
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
  return {
    descriptor: CLI_TOOL_CATALOG[KILO_ID],
    role: 'planner',
    supportsSessionResume: false,
    supportsEffort: false,
    promptTransport: KILO_PROMPT_TRANSPORT,
    baseArgs: plannerBaseArgs,
    buildArgs: (input) => [...plannerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: kiloPlannerProtocolEvents,
    terminal,
    probe: createProbe(),
  };
}

function createImplementerAdapter(): CliImplementerAdapter<'kilo-code'> {
  return {
    descriptor: CLI_TOOL_CATALOG[KILO_ID],
    role: 'implementer',
    promptTransport: KILO_PROMPT_TRANSPORT,
    baseArgs: implementerBaseArgs,
    buildArgs: (input) => [...implementerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
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

function rawContract(role: 'planner' | 'implementer'): RawKiloCliContract {
  return {
    id: KILO_ID,
    command: KILO_COMMAND,
    role,
    versionArgs: KILO_VERSION_ARGS,
    auth: { kind: 'env-or-native', env: [] },
    rawInvocation:
      role === 'planner'
        ? ['run', '--format', 'json', '--agent', 'plan', CLI_PROMPT_SENTINEL]
        : ['run', '--auto', CLI_PROMPT_SENTINEL],
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
    contractSha256: contractSha256(plannerRawContract),
    adapter: kiloPlannerAdapter,
  }),
  Object.freeze({
    id: KILO_ID,
    role: 'implementer',
    rawContract: implementerRawContract,
    contractSha256: contractSha256(implementerRawContract),
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
      prompt: CLI_PROMPT_SENTINEL,
      model: opts.model,
      projectDir: opts.projectDir ?? '',
      configuredArgs,
      mode: opts.mode ?? 'plan',
      sessionId: null,
      effort: undefined,
    });
  }
  return kiloImplementerAdapter.buildArgs({
    prompt: CLI_PROMPT_SENTINEL,
    model: opts.model,
    projectDir: opts.projectDir ?? '',
    configuredArgs,
  });
}
