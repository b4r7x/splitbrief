import { z } from 'zod';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { sha256Hex } from '../../utils/sha256.js';
import { assertNever } from '../../utils/type-guards.js';
import { OutputFormatSchema, type OutputFormat } from '../schemas/enums.js';
import {
  EnvironmentReferenceNameSchema,
  RUNNER_IDLE_KILL_MS,
  RUNNER_IDLE_WARN_MS,
} from '../schemas/runner-fields.js';
import type { Config } from '../schemas/config.js';
import type { ImplementerConfig, ImplementerProfileConfig } from '../schemas/implementer-config.js';
import type { PlannerConfig } from '../schemas/planner-config.js';

const PROMPT_PLACEHOLDER = '{prompt}';
const MAX_LITERAL_LENGTH = 4_096;
const MAX_ARGV_LENGTH = 128;
const MAX_LABEL_LENGTH = 120;
type CommandStringInterpreterFamily = 'posix-shell' | 'powershell' | 'windows-command';

type CommandStringInterpreterProfile = Readonly<{
  family: CommandStringInterpreterFamily;
  names: readonly string[];
}>;

const COMMAND_STRING_INTERPRETER_PROFILES: readonly CommandStringInterpreterProfile[] = [
  {
    family: 'posix-shell',
    names: ['ash', 'bash', 'dash', 'ksh', 'mksh', 'sh', 'zsh'],
  },
  {
    family: 'powershell',
    names: ['powershell', 'pwsh'],
  },
  {
    family: 'windows-command',
    names: ['cmd'],
  },
];

const credentialPatterns = [
  /(?:^|[^a-z0-9])(?:sk|pk)[_-][a-z0-9_-]{8,}/i,
  /(?:^|[^a-z0-9])(?:ghp_|github_pat_|glpat-|xox[baprs]-|akia|aiza)[a-z0-9_-]+/i,
  /\b(?:api[_-]?key|access[_-]?token|token|secret|password)\s*[=:]\s*\S+/i,
  /^bearer\s+\S+/i,
];

function hasCredentialLikeLiteral(value: string): boolean {
  return credentialPatterns.some((pattern) => pattern.test(value));
}

function hasUnsafeExecutableSyntax(value: string): boolean {
  return /(?:\$\{|\$\(|`|\$[A-Za-z_]|[|;&><]|\r|\n)/.test(value);
}

function executableName(value: string): string {
  const separator = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return value
    .slice(separator + 1)
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

function commandStringInterpreterProfile(
  value: string,
): CommandStringInterpreterProfile | undefined {
  const name = executableName(value);
  return COMMAND_STRING_INTERPRETER_PROFILES.find((profile) => profile.names.includes(name));
}

function consumesPosixShellOptionArgument(value: string): boolean {
  return (
    value === '-O' ||
    value === '+O' ||
    value === '-o' ||
    value === '+o' ||
    value === '--init-file' ||
    value === '--rcfile'
  );
}

function isPosixShellCommandStringOption(value: string): boolean {
  if (value === '-c' || value === '--command' || value.startsWith('--command=')) return true;
  return /^-[A-Za-z]*c[A-Za-z]*$/.test(value);
}

function hasPosixShellCommandStringMode(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || argument === '--' || argument === '-') return false;
    if (!argument.startsWith('-') && !argument.startsWith('+')) return false;
    if (isPosixShellCommandStringOption(argument)) return true;
    if (consumesPosixShellOptionArgument(argument)) index += 1;
  }
  return false;
}

function isPowerShellCommandStringOption(value: string): boolean {
  const option = value.toLowerCase();
  return (
    option === '-c' ||
    option === '-command' ||
    option.startsWith('-command:') ||
    option === '-e' ||
    option === '-enc' ||
    option === '-encodedcommand' ||
    option.startsWith('-encodedcommand:')
  );
}

function consumesPowerShellOptionArgument(value: string): boolean {
  return [
    '-configurationname',
    '-executionpolicy',
    '-inputformat',
    '-outputformat',
    '-settingsfile',
    '-version',
    '-windowstyle',
    '-workingdirectory',
  ].includes(value.toLowerCase());
}

function hasPowerShellCommandStringMode(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || argument === '--' || argument === '-') return false;
    if (!argument.startsWith('-')) return false;
    if (isPowerShellCommandStringOption(argument)) return true;
    if (argument.toLowerCase() === '-file') return false;
    if (consumesPowerShellOptionArgument(argument)) index += 1;
  }
  return false;
}

function hasWindowsCommandStringMode(argv: readonly string[]): boolean {
  for (const argument of argv) {
    if (argument === undefined || argument === '--' || argument === '-') return false;
    if (argument.toLowerCase() === '/c' || argument.toLowerCase() === '/k') return true;
    if (!argument.startsWith('/') && !argument.startsWith('-')) return false;
  }
  return false;
}

function hasInterpreterCommandString(executable: string, argv: readonly string[]): boolean {
  const profile = commandStringInterpreterProfile(executable);
  if (profile === undefined) return false;
  switch (profile.family) {
    case 'posix-shell':
      return hasPosixShellCommandStringMode(argv);
    case 'powershell':
      return hasPowerShellCommandStringMode(argv);
    case 'windows-command':
      return hasWindowsCommandStringMode(argv);
    default:
      return assertNever(profile.family);
  }
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function envDispatchesInterpreterCommandString(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) return false;
    if (
      argument === '-S' ||
      argument === '--split-string' ||
      argument.startsWith('--split-string=')
    ) {
      return true;
    }
    if (argument === '--') {
      const executable = argv[index + 1];
      return (
        executable !== undefined && hasInterpreterCommandString(executable, argv.slice(index + 2))
      );
    }
    if (
      isEnvironmentAssignment(argument) ||
      argument === '-i' ||
      argument === '--ignore-environment'
    ) {
      continue;
    }
    if (argument === '-u' || argument === '--unset') {
      index += 1;
      continue;
    }
    if (argument.startsWith('--unset=')) continue;
    if (argument === '-C' || argument === '--chdir') {
      index += 1;
      continue;
    }
    if (argument.startsWith('--chdir=')) continue;
    if (argument.startsWith('-')) return false;
    return hasInterpreterCommandString(argument, argv.slice(index + 1));
  }
  return false;
}

function storesInterpreterCommandString(executable: string, argv: readonly string[]): boolean {
  if (hasInterpreterCommandString(executable, argv)) return true;
  return executableName(executable) === 'env' && envDispatchesInterpreterCommandString(argv);
}

function hasRepeatedValues(values: readonly string[] | undefined): boolean {
  return values !== undefined && new Set(values).size !== values.length;
}

function defaultedIdleWarnMs(value: number | undefined): number {
  return value ?? RUNNER_IDLE_WARN_MS;
}

function defaultedIdleKillMs(value: number | undefined): number {
  return value ?? RUNNER_IDLE_KILL_MS;
}

export const CustomCommandIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'Use lowercase letters, numbers, and hyphens; start with a letter');

export const CustomCommandContractSchema = z.enum(['output', 'direct']);
export type CustomCommandContract = z.infer<typeof CustomCommandContractSchema>;

const LiteralStringSchema = z.string().min(1).max(MAX_LITERAL_LENGTH);

export const CustomCommandDefinitionSchema = z
  .strictObject({
    label: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
    contract: CustomCommandContractSchema,
    executable: LiteralStringSchema.refine((value) => value.trim().length > 0, {
      message: 'executable must not be empty',
    }),
    argv: z.array(LiteralStringSchema).max(MAX_ARGV_LENGTH).optional(),
    outputFormat: OutputFormatSchema.optional(),
    idleWarnMs: z.number().int().positive().max(3_600_000).optional(),
    idleKillMs: z.number().int().positive().max(3_600_000).optional(),
    env: z.array(EnvironmentReferenceNameSchema).max(64).optional(),
  })
  .superRefine((definition, ctx) => {
    if (hasRepeatedValues(definition.env)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['env'],
        message: 'Each environment reference may be declared only once',
      });
    }

    const idleWarnMs = defaultedIdleWarnMs(definition.idleWarnMs);
    const idleKillMs = defaultedIdleKillMs(definition.idleKillMs);
    if (idleKillMs < idleWarnMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['idleKillMs'],
        message: 'idleKillMs must be at least idleWarnMs',
      });
    }

    const literalFields: Array<{ path: Array<string | number>; value: string }> = [
      { path: ['label'], value: definition.label },
      { path: ['executable'], value: definition.executable },
      ...(definition.argv ?? []).map((value, index) => ({
        path: ['argv', index],
        value,
      })),
    ];
    for (const { path, value } of literalFields) {
      if (hasCredentialLikeLiteral(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: 'Use a declared environment reference instead of a credential-like literal',
        });
      }
      if (value.includes(PROMPT_PLACEHOLDER)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            'Pass prompt data through stdin; use an environment reference only for credentials',
        });
      }
    }

    if (hasUnsafeExecutableSyntax(definition.executable)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executable'],
        message:
          'Use one literal executable path; use an environment reference only for credentials',
      });
    }

    if (storesInterpreterCommandString(definition.executable, definition.argv ?? [])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['argv'],
        message:
          'Use literal argv instead of an interpreter command string; pass prompt data through stdin and credentials through declared environment references',
      });
    }
  });

export type CustomCommandDefinition = z.infer<typeof CustomCommandDefinitionSchema>;

const CustomCommandShape = {
  id: CustomCommandIdSchema,
  label: z.string().min(1).max(MAX_LABEL_LENGTH),
  contract: CustomCommandContractSchema,
  executable: LiteralStringSchema,
  argv: z.array(LiteralStringSchema).max(MAX_ARGV_LENGTH).readonly(),
  outputFormat: OutputFormatSchema,
  idleWarnMs: z.number().int().positive().max(3_600_000),
  idleKillMs: z.number().int().positive().max(3_600_000),
  env: z.array(EnvironmentReferenceNameSchema).max(64).readonly(),
} as const;

/**
 * A runner declared inline in `planner`/`implementer` carries the same
 * execution tuple as a `customCommands` entry but not its literal policy: the
 * runner block has always accepted interpreter command strings, empty argv
 * entries, and unbounded lists. Admission has to be able to describe one in
 * order to ask about it, so these three fields mirror the runner block rather
 * than the stricter `customCommands` definition.
 */
export const InlineRunnerCommandSchema = z
  .strictObject({
    ...CustomCommandShape,
    executable: z.string().min(1),
    argv: z.array(z.string()).readonly(),
    env: z.array(EnvironmentReferenceNameSchema).readonly(),
  })
  .readonly();

export const NormalizedCustomCommandSchema = z
  .strictObject(CustomCommandShape)
  .superRefine((command, ctx) => {
    const definition = CustomCommandDefinitionSchema.safeParse({
      label: command.label,
      contract: command.contract,
      executable: command.executable,
      argv: command.argv,
      outputFormat: command.outputFormat,
      idleWarnMs: command.idleWarnMs,
      idleKillMs: command.idleKillMs,
      env: command.env,
    });
    if (!definition.success) {
      ctx.addIssue({ code: 'custom', message: 'Custom command definition is invalid' });
      return;
    }
    const normalized = normalizeCustomCommand(command.id, definition.data);
    if (canonicalJSON(command) !== canonicalJSON(normalized)) {
      ctx.addIssue({ code: 'custom', message: 'Custom command definition is not normalized' });
    }
  })
  .readonly();

export type CustomCommand = z.infer<typeof NormalizedCustomCommandSchema>;

export type CustomCommandRunner = Extract<
  PlannerConfig | ImplementerConfig | ImplementerProfileConfig,
  { kind: 'shell' | 'agent' }
>;

export type CustomCommandExecutionTuple = Readonly<{
  contract: CustomCommandContract;
  executable: string;
  argv: readonly string[];
  outputFormat: OutputFormat;
  idleWarnMs: number;
  idleKillMs: number;
  env: readonly string[];
}>;

type CustomCommandTupleInput = Readonly<{
  id?: string | undefined;
  contract: CustomCommandContract;
  executable: string;
  argv?: readonly string[] | undefined;
  outputFormat?: OutputFormat | undefined;
  idleWarnMs?: number | undefined;
  idleKillMs?: number | undefined;
  env?: readonly string[] | undefined;
}>;

export function customCommandTuple(input: CustomCommandTupleInput): CustomCommandExecutionTuple {
  return {
    contract: input.contract,
    executable: input.executable,
    argv: [...(input.argv ?? [])],
    outputFormat: input.outputFormat ?? 'text',
    idleWarnMs: defaultedIdleWarnMs(input.idleWarnMs),
    idleKillMs: defaultedIdleKillMs(input.idleKillMs),
    env: [...(input.env ?? [])].sort(),
  };
}

export function isCustomCommandRunner(
  runner: PlannerConfig | ImplementerConfig | ImplementerProfileConfig,
): runner is CustomCommandRunner {
  return runner.kind === 'shell' || runner.kind === 'agent';
}

export function customCommandTupleForRunner(
  runner: CustomCommandRunner,
): CustomCommandExecutionTuple {
  return customCommandTuple({
    contract: runner.kind === 'shell' ? 'output' : 'direct',
    executable: runner.command,
    argv: runner.args,
    outputFormat: runner.outputFormat,
    idleWarnMs: runner.idleWarnMs,
    idleKillMs: runner.idleKillMs,
    env: runner.env,
  });
}

const INLINE_RUNNER_ID_DIGEST_CHARS = 16;

export type InlineRunnerCommand = z.infer<typeof InlineRunnerCommandSchema>;

/**
 * Names an inline `planner`/`implementer` runner declaration for owner-only
 * trust receipts. The id is derived from the role and the execution tuple, so
 * a receipt survives unrelated config edits and never carries to a command the
 * owner did not see.
 */
export function inlineRunnerCommand(
  input: Readonly<{ runner: CustomCommandRunner; role: 'planner' | 'implementer' }>,
): InlineRunnerCommand {
  const tuple = customCommandTupleForRunner(input.runner);
  const digest = sha256Hex(canonicalJSON(tuple)).slice(0, INLINE_RUNNER_ID_DIGEST_CHARS);
  return InlineRunnerCommandSchema.parse({
    id: `inline-${input.role}-${digest}`,
    label: `Inline ${input.runner.kind} runner`,
    ...tuple,
  });
}

function tupleKey(tuple: CustomCommandExecutionTuple): string {
  return JSON.stringify(tuple);
}

export function isSameCustomCommandTuple(
  input: Readonly<{
    left: CustomCommandTupleInput;
    right: CustomCommandTupleInput;
  }>,
): boolean {
  return tupleKey(customCommandTuple(input.left)) === tupleKey(customCommandTuple(input.right));
}

export function matchesCustomCommandRunner(
  runner: CustomCommandRunner,
  command: CustomCommand | CustomCommandDefinition,
): boolean {
  return isSameCustomCommandTuple({
    left: customCommandTupleForRunner(runner),
    right: command,
  });
}

export const CustomCommandsConfigSchema = z
  .record(CustomCommandIdSchema, CustomCommandDefinitionSchema)
  .superRefine((commands, ctx) => {
    const seen: Array<{ id: string; definition: CustomCommandDefinition }> = [];
    for (const [id, definition] of Object.entries(commands)) {
      const earlier = seen.find((candidate) =>
        isSameCustomCommandTuple({ left: candidate.definition, right: definition }),
      );
      const earlierId = earlier?.id;
      if (earlierId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [id],
          message: `Custom command duplicates the normalized execution tuple of "${earlierId}"`,
        });
      } else {
        seen.push({ id, definition });
      }
    }
  });

export function normalizeCustomCommand(
  id: string,
  definition: CustomCommandDefinition,
): CustomCommand {
  const tuple = customCommandTuple(definition);
  return { id, label: definition.label, ...tuple };
}

type LegacyCommandCandidate = Readonly<{
  source: string;
  runner: CustomCommandRunner;
}>;

export type SafeLegacyCustomCommand = Readonly<{
  kind: 'safe';
  command: CustomCommand;
  sources: readonly string[];
}>;

export type UnsafeLegacyCustomCommand = Readonly<{
  kind: 'unsafe';
  opaqueId: string;
  contract: CustomCommandContract;
  label: string;
  remediation: string;
}>;

export type LegacyCustomCommand = SafeLegacyCustomCommand | UnsafeLegacyCustomCommand;

export type CustomCommandCatalog = Readonly<{
  configured: readonly CustomCommand[];
  legacy: readonly LegacyCustomCommand[];
}>;

const opaqueLegacyIds = new WeakMap<object, string>();
let nextOpaqueLegacyId = 1;

function opaqueLegacyId(runner: object): string {
  const existing = opaqueLegacyIds.get(runner);
  if (existing !== undefined) return existing;

  const opaqueId = `legacy-unsafe-${nextOpaqueLegacyId}`;
  nextOpaqueLegacyId += 1;
  opaqueLegacyIds.set(runner, opaqueId);
  return opaqueId;
}

function legacyCandidates(config: Config): readonly LegacyCommandCandidate[] {
  const candidates: LegacyCommandCandidate[] = [];
  if (isCustomCommandRunner(config.planner)) {
    candidates.push({ source: 'planner', runner: config.planner });
  }
  if (isCustomCommandRunner(config.implementer)) {
    candidates.push({ source: 'implementer', runner: config.implementer });
  }

  const profiles = config.implementerProfiles?.profiles;
  if (profiles !== undefined) {
    for (const [name, runner] of Object.entries(profiles).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!isCustomCommandRunner(runner)) continue;
      candidates.push({ source: `implementerProfiles.${name}`, runner });
    }
  }

  return candidates;
}

function legacyDefinition(runner: CustomCommandRunner): CustomCommandDefinition {
  const tuple = customCommandTupleForRunner(runner);
  return {
    label: 'Legacy command',
    ...tuple,
    argv: [...tuple.argv],
    env: [...tuple.env],
  };
}

function configuredCommands(config: Config): readonly CustomCommand[] {
  return Object.entries(config.customCommands ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, definition]) => normalizeCustomCommand(id, definition));
}

function unsafeLegacyCommand(runner: CustomCommandRunner): UnsafeLegacyCustomCommand {
  return {
    kind: 'unsafe',
    opaqueId: opaqueLegacyId(runner),
    contract: runner.kind === 'shell' ? 'output' : 'direct',
    label: 'Legacy command requires remediation',
    remediation:
      'Move sensitive or interpolated values to a declared environment reference before saving.',
  };
}

export function readCustomCommandCatalog(config: Config): CustomCommandCatalog {
  const configured = configuredCommands(config);
  const configuredTuples = new Set(
    configured.map((command) => tupleKey(customCommandTuple(command))),
  );
  const safeByTuple = new Map<string, { definition: CustomCommandDefinition; sources: string[] }>();
  const unsafe: UnsafeLegacyCustomCommand[] = [];

  for (const candidate of legacyCandidates(config)) {
    const definition = legacyDefinition(candidate.runner);
    const parsed = CustomCommandDefinitionSchema.safeParse(definition);
    if (!parsed.success) {
      unsafe.push(unsafeLegacyCommand(candidate.runner));
      continue;
    }

    const key = tupleKey(customCommandTuple(parsed.data));
    if (configuredTuples.has(key)) continue;
    const existing = safeByTuple.get(key);
    if (existing === undefined) {
      safeByTuple.set(key, { definition: parsed.data, sources: [candidate.source] });
    } else {
      existing.sources.push(candidate.source);
    }
  }

  const safe = [...safeByTuple.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([_, entry], index): SafeLegacyCustomCommand => {
      const contract = entry.definition.contract;
      return {
        kind: 'safe',
        command: normalizeCustomCommand(`legacy-${contract}-${index + 1}`, {
          ...entry.definition,
          label: `Legacy ${contract} command ${index + 1}`,
        }),
        sources: entry.sources,
      };
    });

  return { configured, legacy: [...safe, ...unsafe] };
}

export function findConfiguredCustomCommand(
  config: Config,
  runner: PlannerConfig | ImplementerConfig | ImplementerProfileConfig,
): CustomCommand | undefined {
  if (!isCustomCommandRunner(runner)) return undefined;
  return readCustomCommandCatalog(config).configured.find((command) =>
    matchesCustomCommandRunner(runner, command),
  );
}
