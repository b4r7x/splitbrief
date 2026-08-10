import { parseTextLine } from '../../streaming/parse-text.js';
import type { ParsedLine } from '../types.js';
import { confinedExists } from '../../../lib/confined-fs.js';
import { accumulateTokenUsage } from '../../calls/usage.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { validateCliArgs } from './validate-args.js';

const AIDER_ID = 'aider' as const;
const AIDER_COMMAND = 'aider' as const;
const AIDER_PROMPT_TRANSPORT = Object.freeze({
  kind: 'argv',
  maxBytes: 120_000,
  placement: 'flag-value',
} as const);
const AIDER_VERSION_ARGS = Object.freeze(['--version'] as const);

const AIDER_PROTECTED_FLAGS = new Set([
  '--architect',
  '--auto-commits',
  '--chat-mode',
  '--commit',
  '--dirty-commits',
  '--dry-run',
  '--edit-format',
  '--message',
  '--msg',
  '--model',
  '--no-auto-commits',
  '--no-dirty-commits',
  '--no-dry-run',
  '--no-pretty',
  '--no-stream',
  '--read',
  '--yes-always',
  '-m',
]);
const AIDER_PROTECTED_SHORT_VALUE_FLAGS = new Set(['-m']);

type AiderPlannerBuildInput = Parameters<CliPlannerAdapter<'aider'>['buildArgs']>[0];
type AiderImplementerBuildInput = Parameters<CliImplementerAdapter<'aider'>['buildArgs']>[0];

function validateArgs(invocationArgs: readonly string[], baseArgs: readonly string[]) {
  return validateCliArgs({
    invocationArgs,
    baseArgs,
    protectedFlags: AIDER_PROTECTED_FLAGS,
    protectedShortValueFlags: AIDER_PROTECTED_SHORT_VALUE_FLAGS,
    promptTransport: 'argv',
  });
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
  if (input.mode === 'plan') args.push('--chat-mode', 'ask');
  if (input.mode === 'escalate') args.push('--edit-format', 'whole');
  args.push('--yes-always');
  if (input.mode === 'escalate') {
    args.push('--no-auto-commits', '--no-dirty-commits', '--no-dry-run');
  }
  args.push('--no-stream', '--no-pretty', '--message', input.prompt);
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
  return {
    descriptor: CLI_TOOL_CATALOG.aider,
    role: 'planner',
    supportsSessionResume: false,
    supportsEffort: false,
    promptTransport: AIDER_PROMPT_TRANSPORT,
    baseArgs: plannerBaseArgs,
    buildArgs: (input) => [...plannerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: aiderProtocolEvents,
    terminal,
    probe: createProbe(),
  };
}

function createImplementerAdapter(): CliImplementerAdapter<'aider'> {
  return {
    descriptor: CLI_TOOL_CATALOG.aider,
    role: 'implementer',
    promptTransport: AIDER_PROMPT_TRANSPORT,
    baseArgs: implementerBaseArgs,
    buildArgs: (input) => [...implementerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
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
            CLI_PROMPT_SENTINEL,
          ]
        : [
            '--message',
            CLI_PROMPT_SENTINEL,
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
    contractSha256: contractSha256(plannerRawContract),
    adapter: aiderPlannerAdapter,
  }),
  Object.freeze({
    id: AIDER_ID,
    role: 'implementer',
    rawContract: implementerRawContract,
    contractSha256: contractSha256(implementerRawContract),
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
      prompt: CLI_PROMPT_SENTINEL,
      model: opts.model,
      projectDir: opts.projectDir ?? '',
      configuredArgs,
      mode: opts.mode ?? 'plan',
      sessionId: null,
      effort: undefined,
    });
  }
  return aiderImplementerAdapter.buildArgs({
    prompt: CLI_PROMPT_SENTINEL,
    model: opts.model,
    projectDir: opts.projectDir ?? '',
    configuredArgs,
  });
}
