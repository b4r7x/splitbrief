import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import { parseTextLine } from '../../streaming/parse-text.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import { contractSha256 } from '../../providers/candidate-contract.js';
import type { CliImplementerAdapter, CliPlannerAdapter, CliProtocolEvent } from './contract.js';
import { finalGroupTerminal } from './final-group.js';
import { textLineEvents } from './text-line-events.js';
import { validateCliArgs } from './validate-args.js';

const ANTIGRAVITY_ID = 'antigravity' as const;
const ANTIGRAVITY_COMMAND = 'agy' as const;
const ANTIGRAVITY_PROMPT_TRANSPORT = Object.freeze({
  kind: 'argv',
  maxBytes: 120_000,
  placement: 'positional',
} as const);
const ANTIGRAVITY_VERSION_ARGS = Object.freeze(['--version'] as const);
const ANTIGRAVITY_IMPLEMENTER_TIMEOUT = '20m';
const ANTIGRAVITY_PLANNER_TIMEOUT = '10m';

const ANTIGRAVITY_PROTECTED_FLAGS = new Set([
  '-p',
  '--dangerously-skip-permissions',
  '--output-format',
  '--print-timeout',
  '--model',
  '--effort',
  '--mode',
]);
const ANTIGRAVITY_PROTECTED_SHORT_VALUE_FLAGS = new Set(['-p']);

type AntigravityPlannerBuildInput = Parameters<CliPlannerAdapter<'antigravity'>['buildArgs']>[0];
type AntigravityImplementerBuildInput = Parameters<
  CliImplementerAdapter<'antigravity'>['buildArgs']
>[0];

function validateArgs(input: { invocationArgs: readonly string[]; baseArgs: readonly string[] }) {
  return validateCliArgs({
    ...input,
    protectedFlags: ANTIGRAVITY_PROTECTED_FLAGS,
    protectedShortValueFlags: ANTIGRAVITY_PROTECTED_SHORT_VALUE_FLAGS,
    promptTransport: 'argv',
  });
}

function generationArgs(
  input: Readonly<{ model?: string | undefined; effort?: string | undefined }>,
): string[] {
  return [
    ...(input.model === undefined ? [] : ['--model', input.model]),
    ...(input.effort === undefined ? [] : ['--effort', input.effort]),
  ];
}

function plannerBaseArgs(input: AntigravityPlannerBuildInput): string[] {
  return [
    '-p',
    input.prompt,
    '--mode',
    'plan',
    '--print-timeout',
    ANTIGRAVITY_PLANNER_TIMEOUT,
    ...generationArgs(input),
  ];
}

function implementerBaseArgs(input: AntigravityImplementerBuildInput): string[] {
  return [
    '-p',
    input.prompt,
    '--dangerously-skip-permissions',
    '--print-timeout',
    ANTIGRAVITY_IMPLEMENTER_TIMEOUT,
    ...generationArgs(input),
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
  return textLineEvents(parseTextLine(line));
}

function createPlannerAdapter(): CliPlannerAdapter<'antigravity'> {
  return {
    descriptor: CLI_TOOL_CATALOG[ANTIGRAVITY_ID],
    role: 'planner',
    supportsSessionResume: false,
    supportsEffort: CLI_TOOL_CATALOG[ANTIGRAVITY_ID].supportsEffort,
    promptTransport: ANTIGRAVITY_PROMPT_TRANSPORT,
    baseArgs: plannerBaseArgs,
    buildArgs: (input) => [...plannerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: antigravityProtocolEvents,
    terminal: (input) => finalGroupTerminal({ events: input.events, includeFinalGroupText: true }),
    probe: createProbe(),
  };
}

function createImplementerAdapter(): CliImplementerAdapter<'antigravity'> {
  return {
    descriptor: CLI_TOOL_CATALOG[ANTIGRAVITY_ID],
    role: 'implementer',
    promptTransport: ANTIGRAVITY_PROMPT_TRANSPORT,
    baseArgs: implementerBaseArgs,
    buildArgs: (input) => [...implementerBaseArgs(input), ...input.configuredArgs],
    validateArgs,
    environment: {},
    outputContract: { kind: 'text-exit', successfulExitCodes: [0] },
    parse: antigravityProtocolEvents,
    terminal: (input) => finalGroupTerminal({ events: input.events, includeFinalGroupText: false }),
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
  promptTransport: 'argv';
  expectedRawTerminal: 'process-exit';
  asOf: '2026-09-14';
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
    rawInvocation:
      role === 'planner'
        ? [
            '-p',
            CLI_PROMPT_SENTINEL,
            '--mode',
            'plan',
            '--print-timeout',
            ANTIGRAVITY_PLANNER_TIMEOUT,
          ]
        : [
            '-p',
            CLI_PROMPT_SENTINEL,
            '--dangerously-skip-permissions',
            '--print-timeout',
            ANTIGRAVITY_IMPLEMENTER_TIMEOUT,
          ],
    promptTransport: 'argv',
    expectedRawTerminal: 'process-exit',
    asOf: '2026-09-14',
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
