import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { classifyCliAdmittedVersion } from '../../../core/runners/cli-version.js';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { validateCliArgs } from './validate-args.js';
import {
  createStreamParser,
  parseStreamLine,
  type StreamParseResult,
} from '../../streaming/parse-stream-json.js';
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
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--mcp-config',
  '--settings',
]);

type ClaudeBuildCommon = Readonly<{
  model: string | undefined;
  effort: EffortLevel | undefined;
}>;

type ClaudePlannerBuild = ClaudeBuildCommon &
  Readonly<{
    prompt: string;
    projectDir: string;
    configuredArgs: readonly string[];
    mode: 'plan' | 'escalate';
    sessionId: string | null;
  }>;

type ClaudeImplementerBuild = Readonly<{
  prompt: string;
  model: string | undefined;
  projectDir: string;
  configuredArgs: readonly string[];
  effort?: EffortLevel | undefined;
  installedVersion?: string | undefined;
}>;

function buildBaseArgs(opts: ClaudeBuildCommon): string[] {
  const args: string[] = [...CLAUDE_BASE_ARGS];
  if (opts.model !== undefined) args.push('--model', opts.model);
  if (opts.effort !== undefined) args.push('--effort', opts.effort);
  return args;
}

function plannerBaseArgs(opts: ClaudePlannerBuild): string[] {
  const args = buildBaseArgs(opts);
  // SPLITBRIEF collects planner answers after the CLI turn finishes.
  if (opts.mode === 'plan')
    args.push('--permission-mode', 'plan', '--disallowedTools', 'AskUserQuestion');
  // A non-null sessionId is a handle Claude already minted, so continue that
  // conversation with --resume; --session-id names a NEW session and exits 1
  // ("Session ID <uuid> is already in use.") when given a consumed id.
  if (opts.sessionId !== null) args.push('--resume', opts.sessionId);
  return args;
}

/**
 * The implementer's shell runs in Claude Code's own sandbox: writes stay in the working
 * directory and Claude's session temp, and a blocked command is never retried unsandboxed.
 * `failIfUnavailable: false` is Claude Code's default: a sandbox that cannot start prints a
 * warning and the commands run unconfined, unless a managed policy forces the hard stop.
 * `blockReadsOutsideWorkingDirectories` fences the file tools' reads, and the sandbox's reads
 * under home directories, to the working directory.
 */
function sandboxSettings(input: { readable: readonly string[]; blockReads: boolean }): string {
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: false,
      allowUnsandboxedCommands: false,
      ...(input.readable.length > 0 && { filesystem: { allowRead: input.readable } }),
    },
    ...(input.blockReads && { permissions: { blockReadsOutsideWorkingDirectories: true } }),
  });
}

// Claude Code reads `blockReadsOutsideWorkingDirectories` from 2.1.257 on. An older release
// gets the sandbox without it; an unknown release keeps it.
function blocksReadsOutside(installedVersion: string | undefined): boolean {
  return (
    installedVersion === undefined ||
    classifyCliAdmittedVersion({ installedVersion, minimumAdmittedVersion: '2.1.257' }) !==
      'incompatible'
  );
}

// The run's node_modules links into the checkout (`linkProjectNodeModules`), outside the
// fenced reads: the project's own tsc and vitest only start when the link target is readable.
function linkedNodeModules(projectDir: string): string[] {
  const link = join(projectDir, 'node_modules');
  return existsSync(link) && lstatSync(link).isSymbolicLink() ? [realpathSync(link)] : [];
}

function implementerBaseArgs(opts: ClaudeImplementerBuild): string[] {
  return [
    ...buildBaseArgs({ model: opts.model, effort: opts.effort }),
    '--permission-mode',
    'acceptEdits',
    '--settings',
    sandboxSettings({
      readable: linkedNodeModules(opts.projectDir),
      blockReads: blocksReadsOutside(opts.installedVersion),
    }),
  ];
}

function validateArgs(input: { invocationArgs: readonly string[]; baseArgs: readonly string[] }) {
  return validateCliArgs({
    ...input,
    protectedFlags: CLAUDE_PROTECTED_FLAGS,
    promptTransport: 'stdin',
  });
}

function toProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return protocolEvents(parseStreamLine(line));
}

function protocolEvents(parsed: StreamParseResult): readonly CliProtocolEvent[] {
  const events: CliProtocolEvent[] = [];
  if (parsed.sessionId !== undefined) {
    events.push({ type: 'session', nativeSessionId: parsed.sessionId });
  }
  if (
    !parsed.isResult &&
    ((parsed.text !== undefined && parsed.text.length > 0) || parsed.textSemantics === 'final')
  ) {
    events.push({
      type: 'text',
      channel: parsed.channel ?? 'assistant',
      text: parsed.text ?? '',
      ...(parsed.textSemantics !== undefined && { semantics: parsed.textSemantics }),
    });
  }
  if (parsed.usage !== undefined) {
    events.push({
      type: 'usage',
      usage: parsed.usage,
      semantics: parsed.usageSemantics ?? (parsed.isResult ? 'final' : 'delta'),
    });
  }
  for (const toolUse of parsed.toolUseStart ?? []) {
    events.push({
      type: 'tool-use',
      stage: 'started',
      id: toolUse.id ?? null,
      name: toolUse.name,
      input: { ...toolUse.input },
    });
  }
  for (const toolUse of parsed.toolUse ?? []) {
    events.push({
      type: 'tool-use',
      id: toolUse.id ?? null,
      name: toolUse.name,
      input: { ...toolUse.input },
    });
  }
  for (const warning of parsed.warning ?? []) {
    events.push({
      type: 'warning',
      code: warning.code,
      message: warning.message,
      ...(warning.severity !== undefined && { severity: warning.severity }),
    });
  }
  if (parsed.isHeartbeat) events.push({ type: 'heartbeat' });
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
  const shared = {
    descriptor: CLI_TOOL_CATALOG[CLAUDE_ID],
    role,
    promptTransport: CLAUDE_PROMPT_TRANSPORT,
    validateArgs,
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' } as const,
    parse: toProtocolEvents,
    createParser: () => {
      const parse = createStreamParser();
      return (line: string) => protocolEvents(parse(line));
    },
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
      supportsSessionResume: true,
      supportsEffort: CLI_TOOL_CATALOG[CLAUDE_ID].supportsEffort,
      baseArgs: plannerBaseArgs,
      buildArgs: (input) => [...plannerBaseArgs(input), ...input.configuredArgs],
    } satisfies CliPlannerAdapter<'claude-code'>;
  }

  return {
    ...shared,
    role,
    baseArgs: implementerBaseArgs,
    buildArgs: (input) => [...implementerBaseArgs(input), ...input.configuredArgs],
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

function rawContract(role: 'planner' | 'implementer'): RawClaudeCliContract {
  return {
    id: CLAUDE_ID,
    command: CLAUDE_COMMAND,
    role,
    versionArgs: ['--version'],
    auth: { kind: 'env-or-native', env: ['ANTHROPIC_API_KEY'] },
    rawInvocation:
      role === 'planner'
        ? [...CLAUDE_BASE_ARGS, '--permission-mode', 'plan', '--disallowedTools', 'AskUserQuestion']
        : [
            ...CLAUDE_BASE_ARGS,
            '--permission-mode',
            'acceptEdits',
            '--settings',
            sandboxSettings({ readable: [], blockReads: true }),
          ],
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
    contractSha256: contractSha256(plannerRawContract),
    adapter: claudeCodePlannerAdapter,
  }),
  Object.freeze({
    id: CLAUDE_ID,
    role: 'implementer',
    rawContract: implementerRawContract,
    contractSha256: contractSha256(implementerRawContract),
    adapter: claudeCodeImplementerAdapter,
  }),
]);

export function claudeProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return toProtocolEvents(line);
}
