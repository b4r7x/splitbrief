import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { parseAntigravityLine } from '../../streaming/parse-antigravity.js';
import { error } from '../../../utils/error.js';
import { CLI_PROJECT_DIR_SENTINEL } from './candidate-contract.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import type {
  CliImplementerAdapter,
  CliPlannerAdapter,
  CliProtocolEvent,
  CliSchemaInput,
} from './contract.js';
import { validateCliArgs } from './validate-args.js';

const ANTIGRAVITY_ID = 'antigravity' as const;
const ANTIGRAVITY_COMMAND = 'agy' as const;
const ANTIGRAVITY_PROMPT_TRANSPORT = Object.freeze({ kind: 'stdin' } as const);
const ANTIGRAVITY_VERSION_ARGS = Object.freeze(['--version'] as const);
// In stream-json input agy reads the turn from stdin and drops a prompt given by flag.
const ANTIGRAVITY_INPUT_ARGS = Object.freeze(['--input-format', 'stream-json'] as const);
const ANTIGRAVITY_OUTPUT_ARGS = Object.freeze(['--output-format', 'stream-json'] as const);
// Headless agy ends the turn at the first permission it cannot prompt for, so the planner skips
// the prompts. `--sandbox` blocks shell writes; the file tools are not fenced, and the planning
// mutation guard reports a write inside the project.
const ANTIGRAVITY_PLANNER_ARGS = Object.freeze([
  '--mode',
  'plan',
  '--sandbox',
  '--dangerously-skip-permissions',
] as const);

const ANTIGRAVITY_PROTECTED_FLAGS = new Set([
  '-p',
  '--prompt',
  '--input-format',
  '--dangerously-skip-permissions',
  '--sandbox',
  '--add-dir',
  '--output-format',
  '--print-timeout',
  '--model',
  '--effort',
  '--mode',
  '--json-schema',
]);
const ANTIGRAVITY_PROTECTED_SHORT_VALUE_FLAGS = new Set(['-p']);

type AntigravityPlannerBuildInput = Parameters<CliPlannerAdapter<'antigravity'>['buildArgs']>[0];
type AntigravityImplementerBuildInput = Parameters<
  CliImplementerAdapter<'antigravity'>['buildArgs']
>[0];
type AntigravityTerminalEvent = Extract<CliProtocolEvent, { type: 'result' }>;

function validateArgs(input: { invocationArgs: readonly string[]; baseArgs: readonly string[] }) {
  return validateCliArgs({
    ...input,
    protectedFlags: ANTIGRAVITY_PROTECTED_FLAGS,
    protectedShortValueFlags: ANTIGRAVITY_PROTECTED_SHORT_VALUE_FLAGS,
  });
}

function encodePrompt(input: Readonly<{ prompt: string }>): Promise<string> {
  return Promise.resolve(
    `${JSON.stringify({ event: 'user', message: { content: input.prompt } })}\n`,
  );
}

// `agy models` lists level-specific ids; the 1.3.4 changelog says a base name picks its default
// thinking level without `--effort`. Send the listed id alone so it owns the level that runs.
function generationArgs(input: Readonly<{ model?: string | undefined }>): string[] {
  return input.model === undefined ? [] : ['--model', input.model];
}

function schemaArgs(schema: CliSchemaInput | undefined): string[] {
  return schema === undefined ? [] : ['--json-schema', JSON.stringify(schema.json)];
}

// Headless agy does not make its cwd a workspace: the model is told it has none and runs its
// commands in `~/.gemini/antigravity-cli/scratch`. `--add-dir` names the seat's directory.
function plannerBaseArgs(input: AntigravityPlannerBuildInput): string[] {
  return [
    ...ANTIGRAVITY_INPUT_ARGS,
    ...ANTIGRAVITY_PLANNER_ARGS,
    '--add-dir',
    input.projectDir,
    ...ANTIGRAVITY_OUTPUT_ARGS,
    ...generationArgs(input),
    ...schemaArgs(input.schema),
  ];
}

function implementerBaseArgs(input: AntigravityImplementerBuildInput): string[] {
  return [
    ...ANTIGRAVITY_INPUT_ARGS,
    '--dangerously-skip-permissions',
    '--add-dir',
    input.projectDir,
    ...ANTIGRAVITY_OUTPUT_ARGS,
    ...generationArgs(input),
    ...schemaArgs(input.schema),
  ];
}

function createProbe() {
  return {
    version: {
      command: [ANTIGRAVITY_COMMAND, ...ANTIGRAVITY_VERSION_ARGS] as const,
      cwd: 'neutral' as const,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
    auth: {
      command: [ANTIGRAVITY_COMMAND, 'models'] as const,
      cwd: 'neutral' as const,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    },
  } as const;
}

export function antigravityProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return parseAntigravityLine(line);
}

function antigravityTerminal(input: {
  events: readonly CliProtocolEvent[];
}): AntigravityTerminalEvent {
  const terminal = input.events.findLast(
    (event): event is AntigravityTerminalEvent => event.type === 'result',
  );
  if (terminal === undefined) {
    throw error(
      'antigravity-protocol-failure',
      'Antigravity output ended without a terminal result',
    );
  }
  return terminal;
}

function createPlannerAdapter(): CliPlannerAdapter<'antigravity'> {
  return {
    descriptor: CLI_TOOL_CATALOG[ANTIGRAVITY_ID],
    role: 'planner',
    supportsSessionResume: false,
    supportsEffort: CLI_TOOL_CATALOG[ANTIGRAVITY_ID].supportsEffort,
    // `--sandbox` fences shell writes only; the file tools read the workspace.
    readsFiles: true,
    promptTransport: ANTIGRAVITY_PROMPT_TRANSPORT,
    encodePrompt,
    baseArgs: plannerBaseArgs,
    buildArgs: (input) => [...plannerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' },
    parse: antigravityProtocolEvents,
    terminal: antigravityTerminal,
    probe: createProbe(),
  };
}

function createImplementerAdapter(): CliImplementerAdapter<'antigravity'> {
  return {
    descriptor: CLI_TOOL_CATALOG[ANTIGRAVITY_ID],
    role: 'implementer',
    promptTransport: ANTIGRAVITY_PROMPT_TRANSPORT,
    encodePrompt,
    baseArgs: implementerBaseArgs,
    buildArgs: (input) => [...implementerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'structured-terminal', terminalEvent: 'required' },
    parse: antigravityProtocolEvents,
    terminal: antigravityTerminal,
    probe: createProbe(),
  };
}

export const antigravityPlannerAdapter = createPlannerAdapter();
export const antigravityImplementerAdapter = createImplementerAdapter();

export type RawAntigravityCliContract = Readonly<{
  id: typeof ANTIGRAVITY_ID;
  command: typeof ANTIGRAVITY_COMMAND;
  role: 'planner' | 'implementer';
  versionArgs: readonly ['--version'];
  auth: Readonly<{ kind: 'none'; env: readonly [] }>;
  rawInvocation: readonly string[];
  promptTransport: 'stdin';
  expectedRawTerminal: 'result';
  asOf: '2026-09-23';
}>;

export type AntigravityCliConformanceCandidate = Readonly<{
  id: typeof ANTIGRAVITY_ID;
  role: 'planner' | 'implementer';
  rawContract: RawAntigravityCliContract;
  contractSha256: string;
  adapter: CliPlannerAdapter<'antigravity'> | CliImplementerAdapter<'antigravity'>;
}>;

function rawContract(role: 'planner' | 'implementer'): RawAntigravityCliContract {
  return {
    id: ANTIGRAVITY_ID,
    command: ANTIGRAVITY_COMMAND,
    role,
    versionArgs: ANTIGRAVITY_VERSION_ARGS,
    // `agy` documents no API-key environment variable; `agy models` is the auth probe.
    auth: { kind: 'none', env: [] },
    // agy 1.2.9 does not resolve a relative `--add-dir`: with `.` its shell still started in
    // `~/.gemini/antigravity-cli/scratch`. The raw harness fills in the absolute project path.
    rawInvocation: [
      ...ANTIGRAVITY_INPUT_ARGS,
      ...(role === 'planner' ? ANTIGRAVITY_PLANNER_ARGS : ['--dangerously-skip-permissions']),
      '--add-dir',
      CLI_PROJECT_DIR_SENTINEL,
      ...ANTIGRAVITY_OUTPUT_ARGS,
    ],
    promptTransport: 'stdin',
    expectedRawTerminal: 'result',
    asOf: '2026-09-23',
  };
}

const antigravityPlannerRawContract = rawContract('planner');
const antigravityImplementerRawContract = rawContract('implementer');

export const CLI_CONFORMANCE_CANDIDATES: readonly AntigravityCliConformanceCandidate[] =
  Object.freeze([
    Object.freeze({
      id: ANTIGRAVITY_ID,
      role: 'planner',
      rawContract: antigravityPlannerRawContract,
      contractSha256: contractSha256(antigravityPlannerRawContract),
      adapter: antigravityPlannerAdapter,
    }),
    Object.freeze({
      id: ANTIGRAVITY_ID,
      role: 'implementer',
      rawContract: antigravityImplementerRawContract,
      contractSha256: contractSha256(antigravityImplementerRawContract),
      adapter: antigravityImplementerAdapter,
    }),
  ]);
