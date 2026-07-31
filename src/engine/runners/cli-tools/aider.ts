import { createHash } from 'node:crypto';
import { parseTextLine } from '../../streaming/parse-text.js';
import type { ParsedLine } from '../types.js';
import { confinedExists } from '../../../lib/confined-fs.js';
import { accumulateTokenUsage } from '../../calls/usage.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { isRecord } from '../../../utils/type-guards.js';

const AIDER_ID = 'aider' as const;
const AIDER_COMMAND = 'aider' as const;
const PROMPT_PLACEHOLDER = '<PROMPT>' as const;
const AIDER_PROMPT_TRANSPORT = Object.freeze({ kind: 'argv', maxBytes: 120_000 } as const);
const AIDER_VERSION_ARGS = Object.freeze(['--version'] as const);

const AIDER_PROTECTED_FLAGS = new Set([
  '--chat-mode',
  '--message',
  '--model',
  '--no-auto-commits',
  '--no-dirty-commits',
  '--no-pretty',
  '--no-stream',
  '--read',
  '--yes-always',
]);

type AiderPlannerBuildInput = Parameters<CliPlannerAdapter<'aider'>['buildArgs']>[0];
type AiderImplementerBuildInput = Parameters<CliImplementerAdapter<'aider'>['buildArgs']>[0];

function promptPlaceholderConflict(value: string): boolean {
  return value.includes(PROMPT_PLACEHOLDER) || /^<[^>]+>$/.test(value) || /\{prompt\}/i.test(value);
}

function protectedFlag(value: string): string | null {
  if (AIDER_PROTECTED_FLAGS.has(value)) return value;
  if (!value.startsWith('-')) return null;
  const flag = value.split('=', 1)[0] ?? value;
  return AIDER_PROTECTED_FLAGS.has(flag) ? flag : null;
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
  if (orderConflict) {
    conflicts.push('argument-order');
  }

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

export function aiderProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return toProtocolEvents(parseTextLine(line));
}

function usageFromStderr(stderr: string): TokenDelta | null {
  let usage: TokenDelta | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const parsed = parseTextLine(line);
    if (parsed.usage !== undefined) {
      usage = accumulateTokenUsage(usage, parsed.usage, parsed.usageSemantics ?? 'final');
    }
  }
  return usage;
}

function terminal(input: {
  events: readonly CliProtocolEvent[];
  stderr: string;
}): Extract<CliProtocolEvent, { type: 'result' }> {
  let usage: TokenDelta | null = null;
  for (const event of input.events) {
    if (event.type === 'usage') usage = accumulateTokenUsage(usage, event.usage, event.semantics);
  }
  usage = usageFromStderr(input.stderr) ?? usage;
  return {
    type: 'result',
    status: 'completed',
    text: '',
    usage,
    nativeSessionId: null,
    error: null,
    partial: false,
  };
}

function plannerBaseArgs(input: AiderPlannerBuildInput): string[] {
  const args: string[] = [];
  if (input.model !== undefined) args.push('--model', input.model);
  args.push(
    '--chat-mode',
    'ask',
    '--yes-always',
    '--no-stream',
    '--no-pretty',
    '--message',
    input.prompt,
  );
  if (
    input.mode === 'plan' &&
    input.projectDir.length > 0 &&
    confinedExists(input.projectDir, 'src')
  ) {
    args.push('--read', 'src/');
  }
  return args;
}

function implementerBaseArgs(input: AiderImplementerBuildInput): string[] {
  const args = [
    '--message',
    input.prompt,
    '--yes-always',
    '--no-auto-commits',
    '--no-dirty-commits',
  ];
  if (input.model !== undefined) args.push('--model', input.model);
  return args;
}

function createProbe() {
  return {
    version: {
      command: [AIDER_COMMAND, ...AIDER_VERSION_ARGS] as const,
      cwd: 'neutral' as const,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
    auth: {
      command: [AIDER_COMMAND, 'auth'] as const,
      cwd: 'neutral' as const,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
  } as const;
}

function createPlannerAdapter(): CliPlannerAdapter<'aider'> {
  let baseArgs: readonly string[] | null = null;
  return {
    descriptor: CLI_TOOL_CATALOG.aider,
    role: 'planner',
    promptTransport: AIDER_PROMPT_TRANSPORT,
    buildArgs: (input) => {
      const args = plannerBaseArgs(input);
      baseArgs = args;
      return [...args, ...input.configuredArgs];
    },
    validateArgs: (invocationArgs) => validateArgs(invocationArgs, baseArgs),
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: aiderProtocolEvents,
    terminal,
    probe: createProbe(),
  };
}

function createImplementerAdapter(): CliImplementerAdapter<'aider'> {
  let baseArgs: readonly string[] | null = null;
  return {
    descriptor: CLI_TOOL_CATALOG.aider,
    role: 'implementer',
    promptTransport: AIDER_PROMPT_TRANSPORT,
    buildArgs: (input) => {
      const args = implementerBaseArgs(input);
      baseArgs = args;
      return [...args, ...input.configuredArgs];
    },
    validateArgs: (invocationArgs) => validateArgs(invocationArgs, baseArgs),
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: aiderProtocolEvents,
    terminal,
    probe: createProbe(),
  };
}

export const aiderPlannerAdapter = createPlannerAdapter();
export const aiderImplementerAdapter = createImplementerAdapter();

export type RawAiderCliContract = Readonly<{
  id: typeof AIDER_ID;
  command: typeof AIDER_COMMAND;
  role: 'planner' | 'implementer';
  versionArgs: readonly ['--version'];
  auth: Readonly<{ kind: 'env-or-native'; env: readonly [] }>;
  rawInvocation: readonly string[];
  promptTransport: 'argv';
  expectedRawTerminal: 'process-exit';
  asOf: '2026-07-31';
}>;

export type AiderCliConformanceCandidate = Readonly<{
  id: typeof AIDER_ID;
  role: 'planner' | 'implementer';
  rawContract: RawAiderCliContract;
  contractSha256: string;
  adapter: CliPlannerAdapter<'aider'> | CliImplementerAdapter<'aider'>;
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

function contractHash(contract: RawAiderCliContract): string {
  return createHash('sha256').update(canonicalJson(contract), 'utf8').digest('hex');
}

function rawContract(role: 'planner' | 'implementer'): RawAiderCliContract {
  return {
    id: AIDER_ID,
    command: AIDER_COMMAND,
    role,
    versionArgs: AIDER_VERSION_ARGS,
    auth: { kind: 'env-or-native', env: [] },
    rawInvocation:
      role === 'planner'
        ? [
            '--chat-mode',
            'ask',
            '--yes-always',
            '--no-stream',
            '--no-pretty',
            '--message',
            PROMPT_PLACEHOLDER,
          ]
        : [
            '--message',
            PROMPT_PLACEHOLDER,
            '--yes-always',
            '--no-auto-commits',
            '--no-dirty-commits',
          ],
    promptTransport: 'argv',
    expectedRawTerminal: 'process-exit',
    asOf: '2026-07-31',
  };
}

const plannerRawContract = rawContract('planner');
const implementerRawContract = rawContract('implementer');

export const CLI_CONFORMANCE_CANDIDATES: readonly AiderCliConformanceCandidate[] = Object.freeze([
  Object.freeze({
    id: AIDER_ID,
    role: 'planner',
    rawContract: plannerRawContract,
    contractSha256: contractHash(plannerRawContract),
    adapter: aiderPlannerAdapter,
  }),
  Object.freeze({
    id: AIDER_ID,
    role: 'implementer',
    rawContract: implementerRawContract,
    contractSha256: contractHash(implementerRawContract),
    adapter: aiderImplementerAdapter,
  }),
]);

export function aiderPromptArgs(opts: {
  role: 'planner' | 'implementer';
  model?: string | undefined;
  projectDir?: string | undefined;
  mode?: 'plan' | 'escalate' | undefined;
  configuredArgs?: readonly string[] | undefined;
}): readonly string[] {
  const configuredArgs = opts.configuredArgs ?? [];
  if (opts.role === 'planner') {
    return aiderPlannerAdapter.buildArgs({
      prompt: PROMPT_PLACEHOLDER,
      model: opts.model,
      projectDir: opts.projectDir ?? '',
      configuredArgs,
      mode: opts.mode ?? 'plan',
      sessionId: null,
      effort: undefined,
    });
  }
  return aiderImplementerAdapter.buildArgs({
    prompt: PROMPT_PLACEHOLDER,
    model: opts.model,
    projectDir: opts.projectDir ?? '',
    configuredArgs,
  });
}
