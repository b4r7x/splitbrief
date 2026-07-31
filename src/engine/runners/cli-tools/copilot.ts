import { createHash } from 'node:crypto';
import { accumulateTokenUsage } from '../../calls/usage.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { ParsedLine } from '../types.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { parseTextLine } from '../../streaming/parse-text.js';
import { parseCopilotLine } from '../../streaming/parse-copilot.js';
import { isRecord } from '../../../utils/type-guards.js';

const COPILOT_ID = 'copilot' as const;
const COPILOT_COMMAND = 'copilot' as const;
const PROMPT_PLACEHOLDER = '<PROMPT>' as const;
const COPILOT_PROMPT_TRANSPORT = Object.freeze({ kind: 'argv', maxBytes: 120_000 } as const);
const COPILOT_VERSION_ARGS = Object.freeze(['--version'] as const);

const COPILOT_PROTECTED_FLAGS = new Set(['--allow-all', '--model', '--output-format', '-p']);

type CopilotPlannerBuildInput = Parameters<CliPlannerAdapter<'copilot'>['buildArgs']>[0];
type CopilotImplementerBuildInput = Parameters<CliImplementerAdapter<'copilot'>['buildArgs']>[0];
type CopilotTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function promptPlaceholderConflict(value: string): boolean {
  return value.includes(PROMPT_PLACEHOLDER) || /^<[^>]+>$/.test(value) || /\{prompt\}/i.test(value);
}

function protectedFlag(value: string): string | null {
  if (COPILOT_PROTECTED_FLAGS.has(value)) return value;
  if (!value.startsWith('-')) return null;
  const flag = value.split('=', 1)[0] ?? value;
  return COPILOT_PROTECTED_FLAGS.has(flag) ? flag : null;
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
  if (parsed.isError) {
    events.push({
      type: 'warning',
      code: 'runner_result_error',
      message: parsed.text ?? 'Runner result failed',
    });
  }
  return events;
}

export function copilotPlannerProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return toProtocolEvents(parseCopilotLine(line));
}

export function copilotImplementerProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return toProtocolEvents(parseTextLine(line));
}

export function copilotProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return copilotPlannerProtocolEvents(line);
}

export { parseCopilotLine as copilotParseLine };

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
  let baseArgs: readonly string[] | null = null;
  return {
    descriptor: CLI_TOOL_CATALOG.copilot,
    role: 'planner',
    promptTransport: COPILOT_PROMPT_TRANSPORT,
    buildArgs: (input) => {
      const args = plannerBaseArgs(input);
      baseArgs = args;
      return [...args, ...input.configuredArgs];
    },
    validateArgs: (invocationArgs) => validateArgs(invocationArgs, baseArgs),
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: copilotPlannerProtocolEvents,
    terminal,
    probe: createProbe(),
  };
}

function createImplementerAdapter(): CliImplementerAdapter<'copilot'> {
  let baseArgs: readonly string[] | null = null;
  return {
    descriptor: CLI_TOOL_CATALOG.copilot,
    role: 'implementer',
    promptTransport: COPILOT_PROMPT_TRANSPORT,
    buildArgs: (input) => {
      const args = implementerBaseArgs(input);
      baseArgs = args;
      return [...args, ...input.configuredArgs];
    },
    validateArgs: (invocationArgs) => validateArgs(invocationArgs, baseArgs),
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

function contractHash(contract: RawCopilotCliContract): string {
  return createHash('sha256').update(canonicalJson(contract), 'utf8').digest('hex');
}

function rawContract(role: 'planner' | 'implementer'): RawCopilotCliContract {
  return {
    id: COPILOT_ID,
    command: COPILOT_COMMAND,
    role,
    versionArgs: COPILOT_VERSION_ARGS,
    auth: { kind: 'env-or-native', env: ['GH_TOKEN', 'GITHUB_TOKEN'] },
    rawInvocation:
      role === 'planner'
        ? ['-p', PROMPT_PLACEHOLDER, '--output-format', 'json']
        : ['-p', PROMPT_PLACEHOLDER, '--allow-all'],
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
    contractSha256: contractHash(plannerRawContract),
    adapter: copilotPlannerAdapter,
  }),
  Object.freeze({
    id: COPILOT_ID,
    role: 'implementer',
    rawContract: implementerRawContract,
    contractSha256: contractHash(implementerRawContract),
    adapter: copilotImplementerAdapter,
  }),
]);

export function copilotPromptArgs(opts: {
  role: 'planner' | 'implementer';
  model?: string | undefined;
  configuredArgs?: readonly string[] | undefined;
}): readonly string[] {
  const configuredArgs = opts.configuredArgs ?? [];
  if (opts.role === 'planner') {
    return copilotPlannerAdapter.buildArgs({
      prompt: PROMPT_PLACEHOLDER,
      model: opts.model,
      projectDir: '',
      configuredArgs,
      mode: 'plan',
      sessionId: null,
      effort: undefined,
    });
  }
  return copilotImplementerAdapter.buildArgs({
    prompt: PROMPT_PLACEHOLDER,
    model: opts.model,
    projectDir: '',
    configuredArgs,
  });
}
