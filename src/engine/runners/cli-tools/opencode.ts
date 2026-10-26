import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { classifyCliAdmittedVersion } from '../../../core/runners/cli-version.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { validateCliArgs } from './validate-args.js';
import { errorLineProtocolEvents, errorLineTerminal } from './final-group.js';
import { parseOpencodeLine } from '../../streaming/parse-opencode.js';
import type { ParsedLine } from '../types.js';
import { createOpencodeSteering } from './opencode-steering.js';

const OPENCODE_ID = 'opencode' as const;
const OPENCODE_COMMAND = 'opencode' as const;
const OPENCODE_PROMPT_TRANSPORT = Object.freeze({ kind: 'stdin' } as const);
const OPENCODE_VERSION_ARGS = Object.freeze(['--version'] as const);

const OPENCODE_PROTECTED_FLAGS = new Set([
  '--agent',
  '--format',
  '--model',
  '--prompt',
  '--server',
  '--standalone',
  '--variant',
  '-m',
  'plan',
  'run',
]);
const OPENCODE_PROTECTED_SHORT_VALUE_FLAGS = new Set(['-m']);

type OpenCodePlannerBuildInput = Parameters<CliPlannerAdapter<'opencode'>['buildArgs']>[0];
type OpenCodeImplementerBuildInput = Parameters<CliImplementerAdapter<'opencode'>['buildArgs']>[0];

function validateArgs(input: { invocationArgs: readonly string[]; baseArgs: readonly string[] }) {
  return validateCliArgs({
    ...input,
    protectedFlags: OPENCODE_PROTECTED_FLAGS,
    protectedShortValueFlags: OPENCODE_PROTECTED_SHORT_VALUE_FLAGS,
    positionalPrompt: true,
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
  for (const toolUse of parsed.toolUseStart ?? []) {
    events.push({
      type: 'tool-use',
      stage: 'started',
      id: toolUse.id ?? null,
      name: toolUse.name,
      input: { ...toolUse.input },
    });
  }
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
  return events;
}

export function opencodeProtocolEvents(line: string): readonly CliProtocolEvent[] {
  const errorEvents = errorLineProtocolEvents({
    line,
    errorCode: 'opencode-error',
    defaultMessage: 'OpenCode reported an error',
  });
  return errorEvents ?? toProtocolEvents(parseOpencodeLine(line));
}

function terminal(input: {
  events: readonly CliProtocolEvent[];
}): Extract<CliProtocolEvent, { type: 'result' }> {
  return errorLineTerminal({
    events: input.events,
    includeFinalGroupText: true,
    errorCode: 'opencode-error',
  });
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

/**
 * opencode 2 runs a one-off call on a private server: the background service
 * it otherwise pairs with binds one fixed port, unreachable from a sandboxed
 * HOME. Releases below 2.0.0 reject the flag, as does an unknown release.
 * opencode 2 also dropped `--variant`: the variant rides on the model as
 * `provider/model#variant`, a form 1.x reads as part of the model id.
 */
function runArgs(
  input: Pick<
    OpenCodeImplementerBuildInput,
    'installedVersion' | 'model' | 'variant' | 'imagePaths'
  >,
): string[] {
  const { installedVersion, model, variant } = input;
  const standalone =
    installedVersion !== undefined &&
    classifyCliAdmittedVersion({ installedVersion, minimumAdmittedVersion: '2.0.0' }) ===
      'compatible';
  const args = standalone ? ['run', '--standalone'] : ['run'];
  if (model !== undefined) {
    args.push('--model', standalone && variant !== undefined ? `${model}#${variant}` : model);
  }
  if (!standalone && variant !== undefined) args.push('--variant', variant);
  args.push(...(input.imagePaths ?? []).flatMap((path) => ['--file', path]));
  return args;
}

function plannerBaseArgs(input: OpenCodePlannerBuildInput): string[] {
  const args = runArgs(input);
  args.push('--format', 'json');
  args.push('--agent', 'plan');
  return args;
}

function implementerBaseArgs(input: OpenCodeImplementerBuildInput): string[] {
  const args = runArgs(input);
  args.push('--format', 'json', '--agent', 'build');
  return args;
}

function createPlannerAdapter(): CliPlannerAdapter<'opencode'> {
  return {
    descriptor: CLI_TOOL_CATALOG.opencode,
    role: 'planner',
    supportsSessionResume: false,
    supportsEffort: CLI_TOOL_CATALOG.opencode.supportsEffort,
    promptTransport: OPENCODE_PROMPT_TRANSPORT,
    steering: createOpencodeSteering(opencodeProtocolEvents),
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
    steering: createOpencodeSteering(opencodeProtocolEvents),
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
  promptTransport: 'stdin';
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
        ? ['run', '--format', 'json', '--agent', 'plan']
        : ['run', '--format', 'json', '--agent', 'build'],
    promptTransport: 'stdin',
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
