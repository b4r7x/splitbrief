import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { classifyCliAdmittedVersion } from '../../../../core/runners/cli-tool/version.js';
import type { EffortLevel } from '../../../../core/schemas/enums.js';
import type { CliSchemaInput } from '../contract.js';
import { validateCliArgs } from '../validate-args.js';

export const CLAUDE_STREAM_INPUT_ARGS = ['--input-format', 'stream-json'] as const;
export const CLAUDE_BASE_ARGS = Object.freeze([
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
    projectDir: string;
    configuredArgs: readonly string[];
    sessionId: string | null;
    skillRoots?: readonly string[] | undefined;
  }>;

type ClaudeImplementerBuild = Readonly<{
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

export function plannerBaseArgs(opts: ClaudePlannerBuild): string[] {
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
export function sandboxSettings(input: {
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

export function implementerBaseArgs(opts: ClaudeImplementerBuild): string[] {
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

export function validateArgs(input: {
  invocationArgs: readonly string[];
  baseArgs: readonly string[];
}) {
  return validateCliArgs({
    ...input,
    protectedFlags: CLAUDE_PROTECTED_FLAGS,
  });
}
