import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { accumulateTokenUsage } from '../../calls/usage.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { validateCliArgs } from './validate-args.js';
import { parseOpencodeLine } from '../../streaming/parse-opencode.js';
import type { ParsedLine } from '../types.js';
import { isRecord } from '../../../utils/type-guards.js';

const OPENCODE_ID = 'opencode' as const;
const OPENCODE_COMMAND = 'opencode' as const;
const OPENCODE_PROMPT_TRANSPORT = Object.freeze({
  kind: 'argv',
  maxBytes: 120_000,
  placement: 'positional',
} as const);
const OPENCODE_VERSION_ARGS = Object.freeze(['--version'] as const);

const OPENCODE_PROTECTED_FLAGS = new Set([
  '--agent',
  '--format',
  '--model',
  '--prompt',
  'plan',
  'run',
]);

type OpenCodePlannerBuildInput = Parameters<CliPlannerAdapter<'opencode'>['buildArgs']>[0];
type OpenCodeImplementerBuildInput = Parameters<CliImplementerAdapter<'opencode'>['buildArgs']>[0];
type OpenCodeTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function validateArgs(invocationArgs: readonly string[], baseArgs: readonly string[]) {
  return validateCliArgs({
    invocationArgs,
    baseArgs,
    protectedFlags: OPENCODE_PROTECTED_FLAGS,
    promptTransport: 'argv',
  });
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

function plannerBaseArgs(input: OpenCodePlannerBuildInput): string[] {
  const args = ['run'];
  if (input.model !== undefined) args.push('--model', input.model);
  args.push('--format', 'json', '--agent', 'plan', input.prompt);
  return args;
}

function implementerBaseArgs(input: OpenCodeImplementerBuildInput): string[] {
  const args = ['run'];
  if (input.model !== undefined) args.push('--model', input.model);
  args.push('--format', 'json', input.prompt);
  return args;
}

function createPlannerAdapter(): CliPlannerAdapter<'opencode'> {
  return {
    descriptor: CLI_TOOL_CATALOG.opencode,
    role: 'planner',
    supportsSessionResume: false,
    supportsEffort: false,
    promptTransport: OPENCODE_PROMPT_TRANSPORT,
    baseArgs: plannerBaseArgs,
    buildArgs: (input) => [...plannerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: opencodeProtocolEvents,
    terminal,
    probe: createProbe(),
  };
}

function createImplementerAdapter(): CliImplementerAdapter<'opencode'> {
  return {
    descriptor: CLI_TOOL_CATALOG.opencode,
    role: 'implementer',
    promptTransport: OPENCODE_PROMPT_TRANSPORT,
    baseArgs: implementerBaseArgs,
    buildArgs: (input) => [...implementerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
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

function rawContract(role: 'planner' | 'implementer'): RawOpenCodeCliContract {
  return {
    id: OPENCODE_ID,
    command: OPENCODE_COMMAND,
    role,
    versionArgs: OPENCODE_VERSION_ARGS,
    auth: { kind: 'env-or-native', env: [] },
    rawInvocation:
      role === 'planner'
        ? ['run', '--format', 'json', '--agent', 'plan', CLI_PROMPT_SENTINEL]
        : ['run', '--format', 'json', CLI_PROMPT_SENTINEL],
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
      contractSha256: contractSha256(plannerRawContract),
      adapter: opencodePlannerAdapter,
    }),
    Object.freeze({
      id: OPENCODE_ID,
      role: 'implementer',
      rawContract: implementerRawContract,
      contractSha256: contractSha256(implementerRawContract),
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
      prompt: CLI_PROMPT_SENTINEL,
      model: opts.model,
      projectDir: '',
      configuredArgs,
      mode: 'plan',
      sessionId: null,
      effort: undefined,
    });
  }
  return opencodeImplementerAdapter.buildArgs({
    prompt: CLI_PROMPT_SENTINEL,
    model: opts.model,
    projectDir: '',
    configuredArgs,
  });
}
