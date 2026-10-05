import type { PackageScriptsReadinessInput } from '../../../core/readiness/checks/validation.js';
import type { Config } from '../../../core/schemas/config.js';
import {
  VALIDATION_STAGES,
  type Phase,
  type ValidationStage,
} from '../../../core/schemas/enums.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import { isPackageManager } from '../../../core/trust/path-classification.js';
import type { ManifestCommands } from '../../../core/validation/manifest-commands.js';
import { pythonStack } from '../../../core/validation/stacks/python.js';
import { STACKS } from '../../../core/validation/stacks/registry.js';
import type { Stack } from '../../../core/validation/stacks/types.js';
import { resolveStageCommand } from '../../../core/validation/stage-command.js';
import { isTestPatternSafe } from '../../../core/validation/test-discovery.js';
import { parseShellCommand } from '../../../utils/parse-shell-command.js';
import type { EventBus } from '../../events/types.js';
import { publishWarning } from '../events.js';
import { formatValidationCommand } from '../validation/commands.js';

const PACKAGE_MANAGERS = ['npm', 'npx', 'node', 'pnpm', 'yarn', 'bun', 'make', 'just'];

const ALLOWED_COMMANDS = new Set([
  ...PACKAGE_MANAGERS,
  ...STACKS.flatMap((stack) => stack.allowedCommands),
]);

const SHELL_OPERATORS = /[|&;`$(){}]/;

const INTERPRETERS = new Set(['node', 'python', 'python3']);

const CODE_LOAD_FLAGS = new Set([
  '-e',
  '--eval',
  '-r',
  '--require',
  '--import',
  '-i',
  '--input-type',
  '-c',
  '--command',
  '-p',
  '--print',
  '--run',
]);

const NPX_CODE_LOAD_PACKAGES = new Set(['tsx', 'ts-node', 'ts-node/esm', 'node']);

const NPM_SCRIPT_SUBCOMMANDS = new Set(['run', 'exec', 'exec-env', 'explore']);

const PNPM_SCRIPT_SUBCOMMANDS = new Set(['run', 'exec', 'dlx']);

const YARN_SCRIPT_SUBCOMMANDS = new Set(['run', 'dlx']);

const TASK_RUNNERS = new Set(['make', 'just']);

const STAGE_TARGETS = new Set<string>(VALIDATION_STAGES);

const RUN_FRONT_ENDS = new Set(['uv', 'poetry']);

const PYTHON_TOOLS = new Set(pythonStack.allowedCommands);

const NPX_STACK_TOOLS = new Set(
  STACKS.flatMap((stack) => stack.allowedCommands).filter(
    (tool) =>
      !PACKAGE_MANAGERS.includes(tool) &&
      !INTERPRETERS.has(tool) &&
      !NPX_CODE_LOAD_PACKAGES.has(tool) &&
      !RUN_FRONT_ENDS.has(tool),
  ),
);

const TEST_CONFIG_FLAGS = new Set(['--config', '-c']);

function commandFamily(token: string): string {
  // npx accepts a version, tag, or empty suffix after an unscoped package name.
  const name = token.toLowerCase();
  return name.startsWith('@') || name.includes('/') || name.includes('\\')
    ? name
    : name.replace(/@[^@]*$/, '');
}

function isPathLikeScriptArg(arg: string): boolean {
  if (arg.includes('/') || arg.includes('\\')) return true;
  if (arg.startsWith('.')) return true;
  if (arg === 'scripts' || arg.startsWith('scripts')) return true;
  return /\.(?:[cm]?[jt]sx?|py)$/.test(arg);
}

// A runner front-end (`uv run`, `poetry run`, `make`) can put the interpreter
// anywhere in the line, so the scan starts at the interpreter token, not at 0.
// Its first operand is the script it runs; `-m` hands the line to a Python tool.
function loadsInterpreterScript(tokens: string[]): boolean {
  const start = tokens.findIndex((token) => INTERPRETERS.has(commandFamily(token)));
  if (start === -1) return false;
  for (let index = start + 1; index < tokens.length; index++) {
    const arg = tokens[index];
    if (!arg) continue;
    if (arg === '-' || arg === '--' || !arg.startsWith('-')) return true;
    const flag = arg.startsWith('--') ? arg.replace(/=.*$/s, '') : arg.slice(0, 2);
    if (flag === '-m') {
      const module = arg === '-m' ? tokens[index + 1] : arg.slice(2);
      return module === undefined || !PYTHON_TOOLS.has(module);
    }
    if (CODE_LOAD_FLAGS.has(flag)) return true;
  }
  return false;
}

function loadsNpxScript(tokens: string[]): boolean {
  if (tokens[0] !== 'npx') return false;
  for (let index = 1; index < tokens.length; index++) {
    const arg = tokens[index];
    if (!arg || arg.startsWith('-')) {
      const flag = arg?.replace(/=.*$/s, '');
      if (flag === '--package' || flag === '-p' || flag === '--call' || flag === '-c') return true;
      continue;
    }
    if (isPathLikeScriptArg(arg)) return true;
    if (NPX_CODE_LOAD_PACKAGES.has(commandFamily(arg))) return true;
  }
  return false;
}

function loadsPackageScript(tokens: string[]): boolean {
  const cmd = commandFamily(tokens[0] ?? '');
  if (!cmd) return false;
  const subcommands =
    cmd === 'npm'
      ? NPM_SCRIPT_SUBCOMMANDS
      : cmd === 'pnpm'
        ? PNPM_SCRIPT_SUBCOMMANDS
        : cmd === 'yarn'
          ? YARN_SCRIPT_SUBCOMMANDS
          : null;
  if (!subcommands) return false;
  for (let index = 1; index < tokens.length; index++) {
    const arg = tokens[index];
    if (!arg || arg.startsWith('-')) continue;
    if (subcommands.has(arg)) return true;
  }
  return false;
}

// A package manager runs whatever its first argument names, under many spellings
// (`rum`, `run-s`, `x`, a bare script name), so only `test` passes. A front-end
// (`npx npm`, `uv run npm`) can put it anywhere in the line.
function runsOtherPackageCommand(tokens: string[]): boolean {
  const start = tokens.findIndex((token) => isPackageManager(commandFamily(token)));
  return start !== -1 && tokens[start + 1] !== 'test';
}

function passesPathToTestCommand(tokens: string[]): boolean {
  const start = tokens.findIndex((token) => isPackageManager(commandFamily(token)));
  return start !== -1 && tokens.slice(start + 2).some(isPathLikeScriptArg);
}

// The one make or just form is the stage target that `readManifestCommands` builds.
function runsTaskRecipe(tokens: string[]): boolean {
  const start = tokens.findIndex((token) => TASK_RUNNERS.has(commandFamily(token)));
  if (start === -1) return false;
  return tokens.length !== start + 2 || !STAGE_TARGETS.has(tokens[start + 1] ?? '');
}

// `uv run` and `poetry run` execute the command that follows `run`.
function forwardsUnlistedCommand(tokens: string[]): boolean {
  return tokens.some(
    (token, index) =>
      RUN_FRONT_ENDS.has(commandFamily(token)) &&
      (tokens[index + 1] !== 'run' || !PYTHON_TOOLS.has(tokens[index + 2] ?? '')),
  );
}

function loadsTestRunnerConfig(tokens: string[]): boolean {
  const cmd = tokens[0];
  if (cmd !== 'vitest' && cmd !== 'jest') return false;
  for (let index = 1; index < tokens.length; index++) {
    const arg = tokens[index];
    if (!arg) continue;
    if (TEST_CONFIG_FLAGS.has(arg)) {
      const value = tokens[index + 1];
      if (value && !value.startsWith('-') && isPathLikeScriptArg(value)) return true;
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (isPathLikeScriptArg(value)) return true;
    }
  }
  return false;
}

export function unsafeCommandReason(raw: string): string | null {
  const tokens = parseShellCommand(raw);
  const cmd = tokens[0];
  if (!cmd) return 'names no program';
  if (cmd.includes('/') || cmd.includes('\\')) return 'runs a file by path';
  if (!ALLOWED_COMMANDS.has(cmd)) return 'runs a program outside the allowlist';
  if (loadsInterpreterScript(tokens)) return 'runs a script or inline code';
  if (loadsNpxScript(tokens)) return 'runs code through npx';
  if (loadsPackageScript(tokens)) return 'runs a package script or binary';
  if (runsOtherPackageCommand(tokens)) return 'runs a package manager, not as a bare test';
  if (passesPathToTestCommand(tokens)) return 'passes a path to the test command';
  if (runsTaskRecipe(tokens)) return 'runs make or just, not on a bare stage';
  if (forwardsUnlistedCommand(tokens)) return 'differs from a bare run of a Python tool';
  if (loadsTestRunnerConfig(tokens)) return 'loads a test config by path';
  for (const token of tokens) {
    if (SHELL_OPERATORS.test(token)) return 'contains a shell operator';
  }
  return null;
}

export function checkCommandRefusal(
  command: string,
  {
    npmScriptsApproved,
    packageScripts,
  }: { npmScriptsApproved: boolean; packageScripts: PackageScriptsReadinessInput },
): string | null {
  const tokens = parseShellCommand(command);
  const cmd = tokens[0];
  if (!cmd) return 'names no program';
  const family = commandFamily(cmd);
  if (family === 'npx') {
    const tool = tokens[1] === '--no-install' ? tokens[2] : undefined;
    if (tool === undefined) return 'runs npx without --no-install';
    return NPX_STACK_TOOLS.has(commandFamily(tool))
      ? null
      : 'runs a program outside the stack tools through npx';
  }
  if (npmScriptsApproved && family === 'npm' && tokens[1] === 'run') {
    const script = tokens[2];
    if (script === undefined) return 'runs npm run without a script name';
    if (tokens.some((token) => SHELL_OPERATORS.test(token))) return 'contains a shell operator';
    if (!packageScripts.packageJsonExists) {
      return 'runs an npm script, but package.json was not found';
    }
    if (!Object.hasOwn(packageScripts.scripts, script)) {
      return `runs the npm script ${script}, which package.json does not define`;
    }
    return null;
  }
  return unsafeCommandReason(command);
}

type CommandField = 'typecheckCommand' | 'lintCommand' | 'testCommand';
const COMMAND_FIELDS: ReadonlyArray<readonly [CommandField, ValidationStage]> = [
  ['typecheckCommand', 'typecheck'],
  ['lintCommand', 'lint'],
  ['testCommand', 'test'],
];

const REFUSED_WARNING = {
  category: 'validation',
  code: 'discovered_validation_refused',
} as const;

type StageResolutionContext = {
  projectDir: string;
  config: Config;
  manifest: ManifestCommands;
  stack: Stack | null;
};

export function sanitizeDiscoveredValidation(
  discovered: DiscoveredValidation | null | undefined,
  notices: { bus: EventBus; phase: Phase },
  resolution?: StageResolutionContext,
): DiscoveredValidation | undefined {
  if (!discovered) return undefined;

  const refuse = (message: string) =>
    publishWarning({ ...notices, message, safety: REFUSED_WARNING });
  const sanitized: DiscoveredValidation = {};

  if (discovered.language) sanitized.language = discovered.language;
  if (discovered.testPattern) {
    if (isTestPatternSafe(discovered.testPattern)) {
      sanitized.testPattern = discovered.testPattern;
    } else {
      refuse(
        `The test stage does not take the file pattern ${discovered.testPattern} from the planner: a test pattern may not contain ".." or a path separator, so the stack's test file patterns apply.`,
      );
    }
  }

  for (const [field, stage] of COMMAND_FIELDS) {
    const value = discovered[field];
    if (!value) continue;
    const refusal = unsafeCommandReason(value);
    if (refusal === null) {
      sanitized[field] = value;
      continue;
    }
    // A refusal empties only the discovered rung: config and the manifest outrank it and
    // the stack default follows it, so the stage may still run this very command.
    const resolved =
      resolution === undefined
        ? null
        : resolveStageCommand({ ...resolution, stage, discovered: undefined });
    if (resolved !== null && formatValidationCommand(resolved.cmd, resolved.args) === value) {
      continue;
    }
    refuse(
      `The ${stage} stage does not take ${value} from the planner (it ${refusal}) and uses config, the manifest or the stack default.`,
    );
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}
