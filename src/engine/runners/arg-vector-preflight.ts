import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../core/schemas/config.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import type { ReadinessCheck } from '../../core/readiness/types.js';
import {
  resolveImplementerProfiles,
  type ResolvedImplementerProfile,
} from '../../core/config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import type { ActiveRunnerRole } from '../../core/runners/seat-roles.js';
import { createSanitizedChildEnv } from '../../lib/process/spawn/child-env.js';
import { assertNever } from '../../utils/type-guards.js';
import { spawnWithTimeout } from '../../lib/process/spawn/progress.js';
import { CLI_PROMPT_SENTINEL } from './cli-tools/candidate-contract.js';
import { lookupCliImplementerAdapter, lookupCliPlannerAdapter } from './cli-tools/registry.js';
import { resolveCliExecutableAliases, sanitizedRuntimePath } from './resolve-cli-executable.js';

const HELP_TIMEOUT_MS = 5_000;
const LONG_FLAG_PATTERN = /--[a-z0-9][a-z0-9-]*/gi;
const OPTION_ENTRY_PATTERN = /^\s*--?[a-z0-9]/i;
const OPTION_TOKEN_PATTERN = /^[-<[]/;
const SUBCOMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const PREFLIGHT_SESSION_ID = '00000000-0000-4000-8000-000000000000';

export type ArgVectorPreflightOutcome =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; unsupported: string[]; deprecated: string[] }>;

/**
 * Compares the arg vector SPLITBRIEF would emit for a runner against the
 * flags the installed binary's own help text advertises. A flag the help does
 * not mention at all is reported as unsupported; a flag whose help entry is
 * marked deprecated is reported separately and does not block.
 *
 * The comparison is conservative on purpose: a help text that carries no
 * recognisable long flags (terse or unparsable output) reports ok rather than
 * fabricating blockers from missing negative evidence.
 */
export function checkRunnerArgVector(input: {
  argv: readonly string[];
  helpText: string;
}): ArgVectorPreflightOutcome {
  const emitted = emittedLongFlags(input.argv);
  if (emitted.length === 0) return { ok: true };
  const advertised = advertisedLongFlags(input.helpText);
  if (advertised.size === 0) return { ok: true };
  const unsupported = emitted.filter((flag) => !advertised.has(flag));
  const deprecated = deprecatedLongFlags(
    input.helpText,
    emitted.filter((flag) => advertised.has(flag)),
  );
  if (unsupported.length === 0 && deprecated.length === 0) return { ok: true };
  return { ok: false, unsupported, deprecated };
}

function emittedLongFlags(argv: readonly string[]): string[] {
  const flags: string[] = [];
  for (const arg of argv) {
    const match = /^--[a-z0-9][a-z0-9-]*/i.exec(arg);
    if (match !== null) flags.push(match[0].toLowerCase());
  }
  return flags;
}

/**
 * Authority-bearing long-flag stems (REQ-018): role, permissions,
 * sandbox/containment, cwd or added roots, configuration sources, tools,
 * hooks/plugins/MCP, session selection, prompt transport, output
 * parser/format, terminal protocol, final-output path, updates, and approval
 * behavior. A flag whose normalized name equals a stem or carries it as a
 * dash-delimited segment is a candidate override; SPLITBRIEF owns these fields
 * and user arguments cannot.
 */
const AUTHORITY_LONG_ARGUMENT_STEMS = Object.freeze([
  'role',
  'agent',
  'persona',
  'subagent',
  'permission',
  'dangerously',
  'bypass',
  'sandbox',
  'cwd',
  'cd',
  'dir',
  'root',
  'config',
  'settings',
  'profile',
  'rc',
  'tool',
  'toolset',
  'hook',
  'plugin',
  'mcp',
  'session',
  'resume',
  'continue',
  'fork',
  'transport',
  'stdin',
  'pipe',
  'print',
  'format',
  'parser',
  'json',
  'terminal',
  'tty',
  'pty',
  'output',
  'out-file',
  'artifact',
  'log-file',
  'update',
  'upgrade',
  'approval',
  'allow',
  'yes',
  'accept',
  'ask',
] as const);

/** Authority-bearing short flags shared by the admitted CLI families. */
const AUTHORITY_SHORT_ARGUMENTS = new Set(['-c', '-p', '-r', '-y']);

function longFlagName(argument: string): string | null {
  if (!argument.startsWith('--') || argument.length === 2) return null;
  return argument.slice(2).split('=', 1)[0]?.toLowerCase() ?? null;
}

function isAuthorityLongFlag(name: string): boolean {
  return AUTHORITY_LONG_ARGUMENT_STEMS.some(
    (stem) => name === stem || name.startsWith(`${stem}-`) || name.endsWith(`-${stem}`),
  );
}

/**
 * Semantic override rejection over user-configured arguments (REQ-018): a
 * configured flag that can override role, permissions, sandbox, cwd or added
 * roots, configuration sources, tools, hooks/plugins/MCP, session selection,
 * prompt transport, output parser/format, terminal protocol, final-output
 * path, updates, or approval behavior is reported before any process spawns.
 * Long forms, `--flag=value` attached forms, short forms, and attached short
 * forms are all scanned; a positional separator (`--`) does not hide a flag
 * from the scan. The adapter's own emitted vector is adapter-owned and never
 * reaches this check.
 */
export function semanticConfiguredArgViolations(args: readonly string[]): readonly string[] {
  const violations: string[] = [];
  for (const argument of args) {
    const name = longFlagName(argument);
    if (name !== null) {
      if (isAuthorityLongFlag(name)) violations.push(argument.split('=', 1)[0] ?? argument);
      continue;
    }
    if (argument.startsWith('-') && argument !== '-' && !argument.startsWith('--')) {
      const short = argument.slice(0, 2).toLowerCase();
      if (AUTHORITY_SHORT_ARGUMENTS.has(short)) violations.push(short);
    }
  }
  return violations;
}

function advertisedLongFlags(helpText: string): Set<string> {
  const flags = new Set<string>();
  for (const match of helpText.matchAll(LONG_FLAG_PATTERN)) {
    flags.add(match[0].toLowerCase());
  }
  return flags;
}

/**
 * A flag counts as deprecated only when the marker sits inside that flag's own
 * option entry: the entry starts on the line that declares the flag and ends at
 * the next line that opens another option or another help section. A marker on
 * a neighbouring entry, or the flag's name quoted inside someone else's
 * description, is not evidence about this flag.
 */
function deprecatedLongFlags(helpText: string, flags: readonly string[]): string[] {
  const lines = helpText.split(/\r?\n/);
  return flags.filter((flag) =>
    lines.some((line, index) => declaresFlag({ line, flag }) && entryIsDeprecated(lines, index)),
  );
}

function declaresFlag(input: Readonly<{ line: string; flag: string }>): boolean {
  const { line, flag } = input;
  if (!OPTION_ENTRY_PATTERN.test(line)) return false;
  for (const token of line.trim().split(/\s+/)) {
    if (!OPTION_TOKEN_PATTERN.test(token)) return false;
    if (token.replace(/[,=].*$/, '').toLowerCase() === flag) return true;
  }
  return false;
}

function entryIsDeprecated(lines: readonly string[], start: number): boolean {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) return false;
    if (index > start && opensNewEntry(line)) return false;
    if (/deprecated/i.test(line)) return true;
  }
  return false;
}

function opensNewEntry(line: string): boolean {
  return OPTION_ENTRY_PATTERN.test(line) || /^\S/.test(line);
}

export interface ArgVectorPreflightCheckInput {
  config: Config;
  projectDir: string;
  /** The seats this run reaches; a seat the run never calls is not preflighted. */
  roles: readonly ActiveRunnerRole[];
  runHelp?: (tool: CliToolId, argv: readonly string[]) => Promise<string | null>;
}

export async function collectArgVectorPreflightChecks(
  input: ArgVectorPreflightCheckInput,
): Promise<ReadinessCheck[]> {
  const runHelp = input.runHelp ?? defaultRunHelp(input.projectDir);
  const runners: PreflightRunner[] = [];
  if (input.roles.includes('planner') && input.config.planner.kind === 'cli') {
    runners.push({
      tool: input.config.planner.tool,
      role: 'planner',
      model: input.config.planner.model,
      args: input.config.planner.args,
      effort: input.config.planner.effort,
      variant: input.config.planner.variant,
    });
  }
  if (input.roles.includes('reviewer')) {
    const reviewer = resolveReviewerRunner(input.config);
    if (reviewer.source === 'configured' && reviewer.runner.kind === 'cli') {
      runners.push({
        tool: reviewer.runner.tool,
        role: 'reviewer',
        model: reviewer.runner.model,
        args: reviewer.runner.args,
        effort: reviewer.runner.effort,
        variant: reviewer.runner.variant,
      });
    }
  }
  if (input.roles.includes('implementer')) {
    let profiles: ResolvedImplementerProfile[] = [];
    try {
      profiles = resolveImplementerProfiles(input.config).profiles;
    } catch {
      profiles = [];
    }
    for (const profile of profiles) {
      if (profile.config.kind === 'cli') {
        runners.push({
          tool: profile.config.tool,
          role: 'implementer',
          model: profile.config.model,
          args: profile.config.args,
          effort: profile.config.effort,
          variant: profile.config.variant,
        });
      }
    }
  }
  const checks: ReadinessCheck[] = [];
  for (const runner of runners) {
    checks.push(await buildPreflightCheck(runner, runHelp));
  }
  return checks;
}

type PreflightRunner = Readonly<{
  tool: CliToolId;
  role: ActiveRunnerRole;
  model: string | undefined;
  args: readonly string[] | undefined;
  effort: EffortLevel | undefined;
  variant: string | undefined;
}>;

async function buildPreflightCheck(
  runner: PreflightRunner,
  runHelp: (tool: CliToolId, argv: readonly string[]) => Promise<string | null>,
): Promise<ReadinessCheck> {
  const semantic = semanticConfiguredArgViolations(runner.args ?? []);
  if (semantic.length > 0) return semanticOverrideCheck(runner, semantic);
  const argVectors = emittedArgVectors(runner);
  const unsupported = new Set<string>();
  const deprecated = new Set<string>();
  let compared = false;
  for (const argv of argVectors) {
    const helpText = await runHelp(runner.tool, argv);
    if (helpText === null) continue;
    compared = true;
    const outcome = checkRunnerArgVector({ argv, helpText });
    if (outcome.ok) continue;
    for (const flag of outcome.unsupported) unsupported.add(flag);
    for (const flag of outcome.deprecated) deprecated.add(flag);
  }
  const descriptor = CLI_TOOL_CATALOG[runner.tool];
  const id = argVectorCheckId(runner.tool, runner.role);
  const argvDetails = argVectors.map((argv) => `Emitted argv: ${argv.join(' ')}`);
  if (unsupported.size === 0 && deprecated.size === 0) {
    return {
      id,
      severity: 'ok',
      summary: compared
        ? `${descriptor.displayName} ${runner.role} arg vector is supported by the installed binary.`
        : `${descriptor.displayName} ${runner.role} arg vector could not be compared with the installed binary's help; no conflict is assumed.`,
      details: argvDetails,
      metadata: {
        tool: runner.tool,
        role: runner.role,
        checked: compared ? 'help' : 'unavailable',
      },
    };
  }
  if (unsupported.size > 0) {
    return {
      id,
      severity: 'blocker',
      summary: `${descriptor.displayName} ${runner.role} invocation uses flags the installed binary does not support: ${[...unsupported].join(', ')}.`,
      details: [
        ...argvDetails,
        `The installed binary's help does not list these flags; the first task would fail at attempt one.`,
      ],
      fix: 'Upgrade the installed binary, or remove the unsupported flags from the runner configuration.',
      nextAction: 'fix-config',
      metadata: {
        tool: runner.tool,
        role: runner.role,
        unsupported: [...unsupported],
        deprecated: [...deprecated],
      },
    };
  }
  return {
    id,
    severity: 'warning',
    summary: `${descriptor.displayName} ${runner.role} invocation uses flags the installed binary marks deprecated: ${[...deprecated].join(', ')}.`,
    details: argvDetails,
    metadata: {
      tool: runner.tool,
      role: runner.role,
      unsupported: [],
      deprecated: [...deprecated],
    },
  };
}

/**
 * One arg vector per branch the adapter can take for this role, so a flag that
 * only appears on resume or on an escalated planner call is compared too. The
 * planner's `effort` is configuration rather than a branch, so it rides on every
 * variant whenever the adapter supports it. The review seat takes exactly one
 * branch — a read-only call, which the CLI planner maps to plan mode, with no
 * session to resume — so escalate-mode and resume argv are not its to compare.
 */
function emittedArgVectors(runner: PreflightRunner): readonly (readonly string[])[] {
  switch (runner.role) {
    case 'implementer':
      return [
        lookupCliImplementerAdapter(runner.tool).buildArgs({
          prompt: CLI_PROMPT_SENTINEL,
          model: runner.model,
          projectDir: '.',
          configuredArgs: runner.args ?? [],
          effort: runner.effort,
          variant: runner.variant,
        }),
      ];
    case 'reviewer': {
      const adapter = lookupCliPlannerAdapter(runner.tool);
      return [
        adapter.buildArgs({ ...plannerCommonArgs(runner, adapter), mode: 'plan', sessionId: null }),
      ];
    }
    case 'planner': {
      const adapter = lookupCliPlannerAdapter(runner.tool);
      const common = plannerCommonArgs(runner, adapter);
      const variants = [
        adapter.buildArgs({ ...common, mode: 'plan', sessionId: null }),
        adapter.buildArgs({ ...common, mode: 'escalate', sessionId: null }),
      ];
      if (adapter.supportsSessionResume) {
        variants.push(
          adapter.buildArgs({ ...common, mode: 'plan', sessionId: PREFLIGHT_SESSION_ID }),
        );
      }
      const seen = new Set<string>();
      return variants.filter((argv) => {
        const key = argv.join(' ');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    default:
      return assertNever(runner.role);
  }
}

function plannerCommonArgs(
  runner: PreflightRunner,
  adapter: Readonly<{ supportsEffort: boolean }>,
) {
  return {
    prompt: CLI_PROMPT_SENTINEL,
    model: runner.model,
    projectDir: '.',
    configuredArgs: runner.args ?? [],
    effort: adapter.supportsEffort ? runner.effort : undefined,
    variant: runner.variant,
  };
}

function argVectorCheckId(tool: CliToolId, role: ActiveRunnerRole): string {
  return `runners.cli.${tool}.arg-vector.${role}`;
}

/**
 * A configured arg vector that overrides authority-bearing semantics refuses
 * before any help probe or task spawn (REQ-018): the rejection is the check,
 * and no subprocess runs for the runner.
 */
function semanticOverrideCheck(
  runner: PreflightRunner,
  violations: readonly string[],
): ReadinessCheck {
  const descriptor = CLI_TOOL_CATALOG[runner.tool];
  return {
    id: argVectorCheckId(runner.tool, runner.role),
    severity: 'blocker',
    summary: `${descriptor.displayName} ${runner.role} configuration overrides authority SPLITBRIEF owns: ${violations.join(', ')}.`,
    details: [
      `Configured args: ${(runner.args ?? []).join(' ')}`,
      'SPLITBRIEF owns role, permissions, sandbox/containment, cwd and added roots, configuration sources, tools, hooks/plugins/MCP, session selection, prompt transport, output parser/format, terminal protocol, final-output path, updates, and approval behavior; user arguments cannot override them.',
    ],
    fix: 'Remove the authority-bearing flags from the runner configuration.',
    nextAction: 'fix-config',
    metadata: {
      tool: runner.tool,
      role: runner.role,
      semantic: [...violations],
      unsupported: [],
      deprecated: [],
    },
  };
}

type HelpInvocation = Readonly<{
  executablePath: string;
  env: NodeJS.ProcessEnv;
}>;

/**
 * The help run is a real execution of a real binary, so it takes the same
 * identity the run itself would take: an absolute path the executable-trust
 * ladder admitted, never a bare name the OS resolves against the inherited
 * PATH. A refused or absent candidate yields no help text, which the caller
 * already reports as `ok`.
 */
async function resolveHelpInvocation(
  tool: CliToolId,
  projectDir: string,
): Promise<HelpInvocation | null> {
  try {
    const resolved = await resolveCliExecutableAliases({
      commands: CLI_TOOL_CATALOG[tool].executableAliases,
      projectDir,
    });
    const env = createSanitizedChildEnv(process.env);
    env.PATH = await sanitizedRuntimePath(projectDir);
    return { executablePath: resolved.executable.path, env };
  } catch {
    return null;
  }
}

/**
 * The comparison text is every help the binary itself prints for this argv:
 * the top-level help plus the subcommand's, joined. A single argv legitimately
 * mixes both scopes — Codex 0.147 takes `--sandbox` and `--ask-for-approval`
 * only before `exec`, and `--json` only after it — so scoring one help against
 * the other and keeping the winner reported the loser's flags as unsupported
 * and blocked a run the binary accepts.
 */
function defaultRunHelp(projectDir: string) {
  const helpTexts = new Map<string, Promise<string | null>>();
  const helpFor = (tool: CliToolId, subcommand?: string): Promise<string | null> => {
    const key = subcommand === undefined ? tool : `${tool} ${subcommand}`;
    const cached = helpTexts.get(key);
    if (cached !== undefined) return cached;
    const pending = fetchHelp(tool, projectDir, subcommand);
    helpTexts.set(key, pending);
    return pending;
  };
  return async (tool: CliToolId, argv: readonly string[]): Promise<string | null> => {
    const topLevel = await helpFor(tool);
    if (topLevel === null) return null;
    const subcommand = subcommandCandidate({
      argv,
      topLevelHelp: topLevel,
      command: CLI_TOOL_CATALOG[tool].command,
    });
    if (subcommand === null) return topLevel;
    const subcommandHelp = await helpFor(tool, subcommand);
    if (subcommandHelp === null) return topLevel;
    return `${topLevel}\n${subcommandHelp}`;
  };
}

async function fetchHelp(
  tool: CliToolId,
  projectDir: string,
  subcommand: string | undefined,
): Promise<string | null> {
  const invocation = await resolveHelpInvocation(tool, projectDir);
  if (invocation === null) return null;
  // The help probe runs in a disposable sealed stage, never in the project:
  // a read-only staged probe cannot observe or write project state.
  const stageDir = await mkdtemp(join(tmpdir(), 'splitbrief-help-'));
  try {
    await chmod(stageDir, 0o500);
    return await runHelpCommand(invocation, stageDir, subcommand);
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

async function runHelpCommand(
  invocation: HelpInvocation,
  cwd: string,
  subcommand?: string | undefined,
): Promise<string | null> {
  const args = subcommand === undefined ? ['--help'] : [subcommand, '--help'];
  try {
    const result = await spawnWithTimeout({
      command: invocation.executablePath,
      args,
      cwd,
      env: invocation.env,
      timeout: HELP_TIMEOUT_MS,
      onProgress: () => undefined,
      ledger: false,
    });
    if (result.timedOut) return null;
    return `${result.output}\n${result.stderr}`.trim();
  } catch {
    return null;
  }
}

function subcommandCandidate(
  input: Readonly<{ argv: readonly string[]; topLevelHelp: string; command: string }>,
): string | null {
  const { argv, topLevelHelp, command } = input;
  const commands = commandNames({ helpText: topLevelHelp, command });
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || token.startsWith('-') || token === CLI_PROMPT_SENTINEL) continue;
    const previous = argv[index - 1];
    if (previous?.startsWith('-')) continue;
    if (commands.has(token.toLowerCase())) return token;
  }
  return null;
}

/**
 * clap prints `  exec  Run Codex non-interactively`, yargs prints
 * `  opencode run [message..]  run opencode with a message`. A leading token
 * that repeats the tool's own command name is the binary, not the subcommand,
 * so the name is the token after it — and only when that token is a plain word
 * rather than a `[positional]` placeholder.
 */
function commandNames(input: Readonly<{ helpText: string; command: string }>): Set<string> {
  const { helpText, command } = input;
  const names = new Set<string>();
  let inCommands = false;
  for (const line of helpText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^commands?:?$/i.test(trimmed)) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    if (!/^\s{2,}\S/.test(line)) {
      if (trimmed.length > 0) inCommands = false;
      continue;
    }
    const [first, second] = trimmed.split(/\s+/);
    if (first === undefined) continue;
    const name = first.toLowerCase() === command.toLowerCase() ? second : first;
    if (name === undefined || !SUBCOMMAND_NAME_PATTERN.test(name)) continue;
    names.add(name.toLowerCase());
  }
  return names;
}
