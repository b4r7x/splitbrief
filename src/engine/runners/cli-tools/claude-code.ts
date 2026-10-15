import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { classifyCliAdmittedVersion } from '../../../core/runners/cli-version.js';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import type {
  CliImplementerAdapter,
  CliInvocation,
  CliPlannerAdapter,
  CliProtocolEvent,
  CliSchemaInput,
  CliSteeringTransport,
} from './contract.js';
import { validateCliArgs } from './validate-args.js';
import { parseStreamLine, type StreamParseResult } from '../../streaming/parse-stream-json.js';
import { error } from '../../../utils/error.js';
import { isRecord } from '../../../utils/type-guards.js';
import { createClaudeReplyParser } from './claude-reply-parser.js';
import { readImagesAsBase64 } from '../../streaming/attachments.js';
import { spawnPipeError, type SpawnStdinWriter } from '../../../lib/process/spawn/lifecycle.js';
import type { SteerOutcome } from '../../calls/steering.js';

const CLAUDE_COMMAND = 'claude' as const;
const CLAUDE_ID = 'claude-code' as const;
const CLAUDE_PROMPT_TRANSPORT = Object.freeze({ kind: 'stdin' } as const);
const CLAUDE_STREAM_INPUT_ARGS = ['--input-format', 'stream-json'] as const;
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
  '--input-format',
  '--replay-user-messages',
  '--verbose',
  '--include-partial-messages',
  '--model',
  '--effort',
  '--json-schema',
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
  effort?: EffortLevel | undefined;
  schema?: CliSchemaInput | undefined;
  imagePaths?: readonly string[] | undefined;
}>;

type ClaudePlannerBuild = ClaudeBuildCommon &
  Readonly<{
    prompt: string;
    projectDir: string;
    configuredArgs: readonly string[];
    sessionId: string | null;
    skillRoots?: readonly string[] | undefined;
  }>;

type ClaudeImplementerBuild = Readonly<{
  prompt: string;
  model: string | undefined;
  projectDir: string;
  configuredArgs: readonly string[];
  effort?: EffortLevel | undefined;
  installedVersion?: string | undefined;
  skillRoots?: readonly string[] | undefined;
  schema?: CliSchemaInput | undefined;
  imagePaths?: readonly string[] | undefined;
}>;

function schemaArgs(schema: CliSchemaInput | undefined): string[] {
  return schema === undefined ? [] : ['--json-schema', JSON.stringify(schema.json)];
}

function buildBaseArgs(opts: ClaudeBuildCommon): string[] {
  const args: string[] = [...CLAUDE_BASE_ARGS];
  if (opts.model !== undefined) args.push('--model', opts.model);
  if (opts.effort !== undefined) args.push('--effort', opts.effort);
  args.push(...schemaArgs(opts.schema));
  if (opts.imagePaths !== undefined && opts.imagePaths.length > 0)
    args.push(...CLAUDE_STREAM_INPUT_ARGS);
  return args;
}

/**
 * The run's global skills as working directories every tool may read and none may write:
 * `acceptEdits` accepts an edit in a working directory, and a deny rule wins over it. A rule
 * path that starts with `//` is absolute; the bare path covers a skill that is one file.
 */
function skillRootPermissions(skillRoots: readonly string[]) {
  return {
    additionalDirectories: skillRoots,
    deny: skillRoots.flatMap((root) => [`Edit(/${root})`, `Edit(/${root}/**)`]),
  };
}

function plannerBaseArgs(opts: ClaudePlannerBuild): string[] {
  const args = buildBaseArgs(opts);
  // SPLITBRIEF collects planner answers after the CLI turn finishes.
  args.push('--permission-mode', 'plan', '--disallowedTools', 'AskUserQuestion');
  // A non-null sessionId is a handle Claude already minted, so continue that
  // conversation with --resume; --session-id names a NEW session and exits 1
  // ("Session ID <uuid> is already in use.") when given a consumed id.
  if (opts.sessionId !== null) args.push('--resume', opts.sessionId);
  // The run's global skills: roots the call may read and never write.
  const skillRoots = opts.skillRoots ?? [];
  if (skillRoots.length > 0) {
    args.push(
      '--settings',
      JSON.stringify({
        permissions: skillRootPermissions(skillRoots),
        sandbox: { filesystem: { allowRead: skillRoots, denyWrite: skillRoots } },
      }),
    );
  }
  return args;
}

/**
 * The implementer's shell runs in Claude Code's own sandbox: writes stay in the working
 * directory and Claude's session temp, and a blocked command is never retried unsandboxed.
 * `failIfUnavailable: true` makes a sandbox that cannot start stop the seat at startup
 * instead of running its commands unconfined; readiness names the missing dependency first.
 * `blockReadsOutsideWorkingDirectories` fences the file tools' reads, and the sandbox's reads
 * under home directories, to the working directory, and the run's global skills with it.
 */
function sandboxSettings(input: {
  readable: readonly string[];
  blockReads: boolean;
  skillRoots: readonly string[];
}): string {
  const { skillRoots } = input;
  const readable = [...input.readable, ...skillRoots];
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      ...(readable.length > 0 && {
        filesystem: {
          allowRead: readable,
          ...(skillRoots.length > 0 && { denyWrite: skillRoots }),
        },
      }),
    },
    ...((input.blockReads || skillRoots.length > 0) && {
      permissions: {
        ...(input.blockReads && { blockReadsOutsideWorkingDirectories: true }),
        ...(skillRoots.length > 0 && skillRootPermissions(skillRoots)),
      },
    }),
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
    ...buildBaseArgs(opts),
    '--permission-mode',
    'acceptEdits',
    '--settings',
    sandboxSettings({
      readable: linkedNodeModules(opts.projectDir),
      blockReads: blocksReadsOutside(opts.installedVersion),
      skillRoots: opts.skillRoots ?? [],
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

function createClaudeParser(): (line: string) => readonly CliProtocolEvent[] {
  const parse = createClaudeReplyParser();
  return (line) => protocolEvents(parse(line), line);
}

function toProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return protocolEvents(parseStreamLine(line), line);
}

function protocolEvents(parsed: StreamParseResult, line: string): readonly CliProtocolEvent[] {
  const events: CliProtocolEvent[] = [];
  if (parsed.inputAck !== undefined) events.push({ type: 'input-ack', text: parsed.inputAck });
  if (parsed.sessionId !== undefined) {
    events.push({ type: 'session', nativeSessionId: parsed.sessionId });
  }
  if (
    !parsed.isResult &&
    ((parsed.text !== undefined && parsed.text.length > 0) || parsed.textSemantics === 'final')
  ) {
    const record: unknown = parsed.isSubagent ? JSON.parse(line) : null;
    const subagentId =
      isRecord(record) && typeof record.parent_tool_use_id === 'string'
        ? record.parent_tool_use_id
        : undefined;
    events.push({
      type: 'text',
      channel: parsed.channel ?? 'assistant',
      text: parsed.text ?? '',
      ...(subagentId !== undefined && { subagentId }),
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
  // A tool is started from its first block until its `tool_result`; the whole input re-announces it.
  for (const toolUse of [...(parsed.toolUseStart ?? []), ...(parsed.toolUseInput ?? [])]) {
    events.push({
      type: 'tool-use',
      stage: 'started',
      id: toolUse.id ?? null,
      name: toolUse.name,
      input: { ...toolUse.input },
    });
  }
  for (const toolUse of parsed.toolUseDelta ?? []) {
    events.push({
      type: 'tool-use-delta',
      id: toolUse.id ?? null,
      name: toolUse.name ?? null,
      inputDelta: toolUse.inputDelta,
    });
  }
  for (const toolUse of parsed.toolUse ?? []) {
    events.push({
      type: 'tool-use',
      stage: 'done',
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
      ...(warning.originalModel !== undefined && { originalModel: warning.originalModel }),
      ...(warning.fallbackModel !== undefined && { fallbackModel: warning.fallbackModel }),
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
        ...(parsed.structured !== undefined && { structured: parsed.structured }),
      });
    }
  }
  return events;
}

const CLAUDE_STEERING: CliSteeringTransport = {
  supportsVersion: (installedVersion) =>
    installedVersion !== undefined &&
    classifyCliAdmittedVersion({ installedVersion, minimumAdmittedVersion: '2.1.296' }) ===
      'compatible',
  open: async ({ invocation, prompt, onReady, onAdmissionClosed }) => {
    const baseArgs = invocation.baseArgs ?? invocation.args;
    const flags = [
      ...(baseArgs.includes('--input-format') ? [] : CLAUDE_STREAM_INPUT_ARGS),
      '--replay-user-messages',
    ];
    let writer: SpawnStdinWriter | undefined;
    let writes = Promise.resolve();
    let admissionOpen = true;
    let promptEchoPending = true;
    const pending: { text: string; settle: (outcome: SteerOutcome) => void }[] = [];
    const closeAdmission = () => {
      if (!admissionOpen) return;
      admissionOpen = false;
      try {
        onAdmissionClosed();
      } finally {
        writer?.end();
      }
    };
    return {
      invocation: {
        ...invocation,
        baseArgs: [...baseArgs, ...flags],
        args: [...baseArgs, ...flags, ...invocation.args.slice(baseArgs.length)],
      },
      prompt: await inputLine(prompt, invocation.images),
      parse: createClaudeParser(),
      onAdmissionClosed: closeAdmission,
      onStdinReady: (value) => {
        writer = value;
        if (!admissionOpen) {
          writer.end();
          return;
        }
        onReady((message) => {
          if (!admissionOpen || writer === undefined) return Promise.resolve('deferred');
          const delivery = Promise.withResolvers<SteerOutcome>();
          const entry = { text: message.text, settle: delivery.resolve };
          pending.push(entry);
          writes = writes
            .then(async () => value.write(await inputLine(message.text, message.images)))
            .catch((cause: unknown) => {
              const index = pending.indexOf(entry);
              if (index < 0) return;
              pending.splice(index, 1);
              entry.settle(
                admissionOpen && spawnPipeError.isStdinClosed(cause) ? 'deferred' : 'uncertain',
              );
            });
          return delivery.promise;
        });
      },
      onLine: (_line, events) => {
        for (const event of events) {
          if (event.type === 'input-ack') {
            if (promptEchoPending) {
              if (event.text === prompt) promptEchoPending = false;
            } else if (pending[0]?.text === event.text) {
              pending.shift()?.settle('delivered');
            }
          }
          if (event.type === 'result') {
            closeAdmission();
            return pending.length > 0;
          }
        }
        return false;
      },
      close: async () => {
        try {
          closeAdmission();
        } finally {
          for (const entry of pending.splice(0)) entry.settle('uncertain');
        }
        await writes;
      },
    };
  },
};

async function inputLine(text: string, images?: readonly Attachment[]): Promise<string> {
  if (images === undefined || images.length === 0)
    return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
  let encoded: Awaited<ReturnType<typeof readImagesAsBase64>>;
  try {
    encoded = await readImagesAsBase64([...images]);
  } catch (cause) {
    throw error(
      'prompt-transport-error',
      'Claude Code image attachments could not be read',
      undefined,
      cause,
    );
  }
  const content = [
    { type: 'text', text },
    ...encoded.map(({ mime, data }) => ({
      type: 'image',
      source: { type: 'base64', media_type: mime, data },
    })),
  ];
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
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
    encodePrompt: ({ invocation, prompt }: { invocation: CliInvocation; prompt: string }) =>
      invocation.images !== undefined && invocation.images.length > 0
        ? inputLine(prompt, invocation.images)
        : Promise.resolve(prompt),
    steering: CLAUDE_STEERING,
    validateArgs,
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' } as const,
    parse: toProtocolEvents,
    createParser: createClaudeParser,
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
            sandboxSettings({ readable: [], blockReads: true, skillRoots: [] }),
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
