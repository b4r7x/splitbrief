import { isAbsolute } from 'node:path';
import type { PackageScriptsReadinessInput } from '../../../core/readiness/checks/validation.js';
import type { Config } from '../../../core/schemas/config.js';
import { VALIDATION_STAGES, type Phase } from '../../../core/schemas/enums.js';
import type { DiscoveredValidation } from '../../../core/schemas/workflow.js';
import { isPackageManager } from '../../../core/trust/path-classification.js';
import type { ManifestCommands } from '../../../core/validation/manifest-commands.js';
import { pythonStack } from '../../../core/validation/stacks/python.js';
import { isTestScript, STACKS } from '../../../core/validation/stacks/registry.js';
import type { Stack } from '../../../core/validation/stacks/types.js';
import { resolveTestCommand } from '../../../core/validation/stage-command.js';
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

/** The interpreter options that load code other than a script file. */
const CODE_LOAD_FLAGS: ReadonlySet<string> = new Set([
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

export const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set([
  ...CODE_LOAD_FLAGS,
  '-E',
  '--loader',
  '--experimental-loader',
]);

const NODE_TEST_REPORTERS = new Set(['dot', 'junit', 'spec', 'tap', 'lcov']);
const NODE_TEST_BOOLEAN_FLAGS = new Set([
  '--test',
  '--test-only',
  '--test-force-exit',
  '--test-update-snapshots',
]);
const NODE_TEST_VALUE_FLAGS = new Set([
  '--test-concurrency',
  '--test-coverage-branches',
  '--test-coverage-exclude',
  '--test-coverage-functions',
  '--test-coverage-include',
  '--test-coverage-lines',
  '--test-name-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-shard',
  '--test-skip-pattern',
  '--test-timeout',
]);

/** Node's options that only parse the script: node runs no code of it. */
export const NODE_SYNTAX_CHECK_FLAGS: ReadonlySet<string> = new Set(['-c', '--check']);

/**
 * Whether node's options before its script only parse the script (`node --check x.js`). Any
 * other option can run it: `node --check --build-snapshot x.js` runs `x.js`.
 */
export function nodeParsesOnly(options: readonly string[]): boolean {
  return options.length > 0 && options.every((option) => NODE_SYNTAX_CHECK_FLAGS.has(option));
}

const NPX_CODE_LOAD_PACKAGES = new Set(['tsx', 'ts-node', 'ts-node/esm', 'node']);

const NPM_SCRIPT_SUBCOMMANDS = new Set(['run', 'exec', 'exec-env', 'explore']);

const PNPM_SCRIPT_SUBCOMMANDS = new Set(['run', 'exec', 'dlx']);

const YARN_SCRIPT_SUBCOMMANDS = new Set(['run', 'dlx']);

const RUN_TEST_ALIASES = new Set(['npm', 'pnpm', 'yarn']);

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

function executedProgramPositions(tokens: string[]): number[] {
  const positions: number[] = [];
  let start = 0;
  while (start < tokens.length) {
    positions.push(start);
    const program = commandFamily(tokens[start] ?? '');
    if (program === 'npx') {
      start = tokens.findIndex((token, index) => index > start && !token.startsWith('-'));
      if (start === -1) break;
    } else if (RUN_FRONT_ENDS.has(program) && tokens[start + 1] === 'run') {
      start += 2;
    } else {
      break;
    }
  }
  return positions;
}

const NODE_TEST_STACKS = STACKS.filter((stack) => stack.allowedCommands.includes('node'));

function isWorkspacePath(arg: string): boolean {
  return !isAbsolute(arg) && !arg.split(/[\\/]/).includes('..');
}

function isWorkspaceFile(arg: string): boolean {
  return isWorkspacePath(arg) && !/[*?[\]]/.test(arg) && !arg.endsWith('/');
}

/** `executed`: the command runs this interpreter, rather than passing its name as an argument. */
function interpreterRefusal({
  tokens,
  start,
  executed,
}: {
  tokens: string[];
  start: number;
  executed: boolean;
}): string | null {
  const program = commandFamily(tokens[start] ?? '');
  const node = executed && program === 'node';
  const operandAt = tokens.findIndex((arg, index) => index > start && !arg.startsWith('-'));
  const options = tokens.slice(start + 1, operandAt === -1 ? undefined : operandAt);
  const parsesOnly = node && nodeParsesOnly(options);
  const nodeTestFiles =
    node &&
    operandAt !== -1 &&
    options.includes('--test') &&
    !options.some((option) => option.startsWith('-m'));
  const codeFlags = nodeTestFiles ? INLINE_CODE_FLAGS : CODE_LOAD_FLAGS;
  let testRunner = false;
  for (let index = start + 1; index < tokens.length; index++) {
    const arg = tokens[index];
    if (!arg) continue;
    if (arg === '-') return `reads code from standard input (${program} -)`;
    if (arg === '--') return `uses the script separator ${program} --`;
    if (!arg.startsWith('-')) {
      if (parsesOnly) {
        if (!isWorkspacePath(arg)) {
          return `passes a path outside the workspace to ${program} (${arg})`;
        }
        return isWorkspaceFile(arg) ? null : `passes an operand to ${program} (${arg})`;
      }
      // node's test runner reads every word after its options as a file to run.
      const operand = testRunner
        ? tokens
            .slice(index)
            .find((token) => !isWorkspaceFile(token) || !isTestScript(token, NODE_TEST_STACKS))
        : arg;
      return operand === undefined ? null : `passes an operand to ${program} (${operand})`;
    }
    if (parsesOnly && NODE_SYNTAX_CHECK_FLAGS.has(arg)) continue;
    if (node && arg === '--test') testRunner = true;
    const flag = arg.startsWith('--') ? arg.replace(/=.*$/s, '') : arg.slice(0, 2);
    if (flag === '-m') {
      const module = arg === '-m' ? tokens[index + 1] : arg.slice(2);
      if (module === undefined) return `runs ${program} -m without a module name`;
      return PYTHON_TOOLS.has(module)
        ? null
        : `runs a Python module outside the stack tools (${module})`;
    }
    if (codeFlags.has(flag)) return `uses the code-loading option ${program} ${flag}`;
    if (nodeTestFiles && !NODE_TEST_BOOLEAN_FLAGS.has(flag) && !NODE_TEST_VALUE_FLAGS.has(flag)) {
      return `uses an unsupported test-file option ${program} ${flag}`;
    }
    if (nodeTestFiles && !arg.includes('=') && !NODE_TEST_BOOLEAN_FLAGS.has(flag)) {
      return `requires ${flag}=<value> before a test file`;
    }
    if (nodeTestFiles && flag === '--test-reporter') {
      const reporter = arg.slice('--test-reporter='.length);
      if (!NODE_TEST_REPORTERS.has(reporter)) {
        return `loads a test reporter outside Node's built-in reporters (${reporter})`;
      }
    }
  }
  return null;
}

function npxScriptRefusal(tokens: string[]): string | null {
  if (tokens[0] !== 'npx') return null;
  let program: string | undefined;
  for (let index = 1; index < tokens.length; index++) {
    const arg = tokens[index];
    if (!arg || arg.startsWith('-')) {
      const flag = arg?.replace(/=.*$/s, '');
      if (flag === '--package' || flag === '-p' || flag === '--call' || flag === '-c') {
        return program === undefined
          ? `uses the code-loading option npx ${flag}`
          : `passes ${flag} to ${program}; a command through npx takes no -p, --package, -c or --call option`;
      }
      continue;
    }
    if (isPathLikeScriptArg(arg))
      return `passes the path ${arg} through npx; a command through npx takes no path arguments`;
    if (NPX_CODE_LOAD_PACKAGES.has(commandFamily(arg))) {
      return program === undefined
        ? `runs the code loader ${arg} through npx`
        : `passes ${arg} to ${program}; a command through npx takes no tsx, ts-node or node argument`;
    }
    program ??= arg;
  }
  return null;
}

function packageScriptRefusal(tokens: string[]): string | null {
  const cmd = commandFamily(tokens[0] ?? '');
  if (!cmd) return null;
  const subcommands =
    cmd === 'npm'
      ? NPM_SCRIPT_SUBCOMMANDS
      : cmd === 'pnpm'
        ? PNPM_SCRIPT_SUBCOMMANDS
        : cmd === 'yarn'
          ? YARN_SCRIPT_SUBCOMMANDS
          : null;
  if (!subcommands) return null;
  for (let index = 1; index < tokens.length; index++) {
    const arg = tokens[index];
    if (!arg || arg.startsWith('-')) continue;
    if (!subcommands.has(arg)) continue;
    if (index === 1) return `runs a package script or binary (${cmd} ${arg})`;
    const words = [...subcommands];
    const list = `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
    const article = cmd === 'npm' ? 'an' : 'a';
    const command = tokens[1]?.startsWith('-') ? cmd : `${cmd} ${tokens[1]}`;
    return `passes the argument ${arg} to ${command}; ${article} ${cmd} command takes no ${list} argument`;
  }
  return null;
}

// A package manager runs whatever its first argument names, under many spellings
// (`rum`, `run-s`, `x`, a bare script name), so only `test` passes.
function packageCommandRefusal(tokens: string[], start: number): string | null {
  if (tokens[start + 1] === 'test') return null;
  const program = commandFamily(tokens[start] ?? '');
  const next = tokens[start + 1];
  return next === undefined
    ? `runs ${program} without the required test subcommand`
    : `uses ${program} ${next} instead of the required ${program} test`;
}

function testPathRefusal(tokens: string[], start: number): string | null {
  const path = tokens.slice(start + 2).find(isPathLikeScriptArg);
  return path === undefined
    ? null
    : `passes a path to ${commandFamily(tokens[start] ?? '')} test (${path})`;
}

// make and just run only one bare target named typecheck, lint or test.
function taskRecipeRefusal(tokens: string[], start: number): string | null {
  const program = commandFamily(tokens[start] ?? '');
  const target = tokens[start + 1];
  if (target === undefined) return `runs ${program} without a stage target`;
  if (target.startsWith('-')) {
    return `uses the option ${program} ${target}; only a bare stage target is allowed`;
  }
  if (!STAGE_TARGETS.has(target)) return `runs the non-stage target ${program} ${target}`;
  return tokens.length === start + 2
    ? null
    : `passes extra arguments to ${program} ${target}; only one bare stage target is allowed`;
}

// `uv run` and `poetry run` execute the command that follows `run`.
function forwardedCommandRefusal(tokens: string[], start: number): string | null {
  if (tokens[start + 1] === 'run' && PYTHON_TOOLS.has(tokens[start + 2] ?? '')) return null;
  const program = commandFamily(tokens[start] ?? '');
  const next = tokens[start + 1];
  if (next === undefined) return `runs ${program} without the required run subcommand`;
  if (next !== 'run') return `uses ${program} ${next} instead of the required ${program} run`;
  const tool = tokens[start + 2];
  return tool === undefined
    ? `runs ${program} run without a Python stack tool`
    : `requires a Python stack tool directly after ${program} run (received ${tool})`;
}

function programArgumentRefusal(tokens: string[], positions: number[], start: number): string {
  const token = tokens[start] ?? '';
  const program = commandFamily(token);
  const names = INTERPRETERS.has(program)
    ? 'node, python or python3'
    : isPackageManager(program)
      ? 'npm, pnpm, yarn or bun'
      : TASK_RUNNERS.has(program)
        ? 'make or just'
        : 'uv or poetry';
  const commandStart = positions.findLast((index) => index < start) ?? 0;
  const cmd = commandFamily(tokens[commandStart] ?? '');
  const command = isPackageManager(cmd) ? `${cmd} test` : tokens[commandStart];
  return `passes ${token} to ${command}; a validation command takes no ${names} argument`;
}

function programRefusal(tokens: string[], positions: number[]): string | null {
  const refusals: { start: number; reason: string }[] = [];
  const check = (start: number, rule: (tokens: string[], start: number) => string | null) => {
    if (start === -1) return;
    const reason = rule(tokens, start);
    if (reason !== null) refusals.push({ start, reason });
  };
  const packageStart = tokens.findIndex((token) => isPackageManager(commandFamily(token)));
  check(packageStart, packageCommandRefusal);
  check(packageStart, testPathRefusal);
  check(
    tokens.findIndex((token) => TASK_RUNNERS.has(commandFamily(token))),
    taskRecipeRefusal,
  );
  for (const [start, token] of tokens.entries()) {
    if (RUN_FRONT_ENDS.has(commandFamily(token))) check(start, forwardedCommandRefusal);
  }
  check(0, testRunnerConfigRefusal);
  check(
    tokens.findIndex((token) => INTERPRETERS.has(commandFamily(token))),
    (_, start) => interpreterRefusal({ tokens, start, executed: positions.includes(start) }),
  );

  const executed = refusals.find(({ start }) => positions.includes(start));
  if (executed !== undefined) return executed.reason;
  const argument = refusals.sort((a, b) => a.start - b.start)[0];
  return argument === undefined ? null : programArgumentRefusal(tokens, positions, argument.start);
}

function testRunnerConfigRefusal(tokens: string[]): string | null {
  const cmd = tokens[0];
  if (cmd !== 'vitest' && cmd !== 'jest') return null;
  for (let index = 1; index < tokens.length; index++) {
    const arg = tokens[index];
    if (!arg) continue;
    if (TEST_CONFIG_FLAGS.has(arg)) {
      const value = tokens[index + 1];
      if (value && !value.startsWith('-') && isPathLikeScriptArg(value)) {
        return `loads a test config by path (${cmd} ${arg} ${value})`;
      }
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (isPathLikeScriptArg(value))
        return `loads a test config by path (${cmd} --config ${value})`;
    }
  }
  return null;
}

// `npm run test`, `pnpm run test` and `yarn run test` run the same scripts as their bare `test`.
// `bun run test` does not: the bare `bun test` is bun's own runner.
function asBareTest(tokens: string[]): string[] {
  const [cmd, run, script, ...rest] = tokens;
  return cmd !== undefined &&
    RUN_TEST_ALIASES.has(commandFamily(cmd)) &&
    run === 'run' &&
    script === 'test'
    ? [cmd, 'test', ...rest]
    : tokens;
}

export function unsafeCommandReason(raw: string): string | null {
  const tokens = asBareTest(parseShellCommand(raw));
  const cmd = tokens[0];
  if (!cmd) return 'names no program';
  if (cmd.includes('/') || cmd.includes('\\')) return `runs a file by path (${cmd})`;
  if (!ALLOWED_COMMANDS.has(cmd)) return `runs a program outside the allowlist (${cmd})`;
  const positions = executedProgramPositions(tokens);
  const refusal =
    npxScriptRefusal(tokens) ?? packageScriptRefusal(tokens) ?? programRefusal(tokens, positions);
  if (refusal !== null) return refusal;
  for (const token of tokens) {
    if (SHELL_OPERATORS.test(token)) return 'contains a shell operator';
  }
  return null;
}

/** The file tests a plan check runs as `test <op> <file>`: each reads one file's state and runs nothing. */
export const FILE_TESTS = {
  '-e': 'exists',
  '-f': 'is a regular file',
  '-x': 'is executable',
  '-L': 'is a symbolic link',
} as const;

function fileTestRefusal(tokens: string[]): string | null {
  const [, test, path] = tokens;
  if (
    tokens.length !== 3 ||
    test === undefined ||
    path === undefined ||
    !Object.hasOwn(FILE_TESTS, test)
  ) {
    const tests = Object.keys(FILE_TESTS);
    return `does not name one file test; a plan check runs test only as test ${tests.slice(0, -1).join(', ')} or ${tests.at(-1)} <file>`;
  }
  if (!isWorkspacePath(path)) return `passes a path outside the workspace to test (${path})`;
  return isWorkspaceFile(path) && !path.startsWith('-') && !SHELL_OPERATORS.test(path)
    ? null
    : `passes an operand to test (${path})`;
}

function isApprovedNpmRun(tokens: string[], npmScriptsApproved: boolean): boolean {
  return npmScriptsApproved && commandFamily(tokens[0] ?? '') === 'npm' && tokens[1] === 'run';
}

/**
 * What the plan command policy refuses from the command text alone. A plan check names it before
 * any task runs: whether package.json defines an npm script waits for the check, since a task can
 * add the script.
 */
export function commandTextRefusal(command: string, npmScriptsApproved: boolean): string | null {
  const tokens = parseShellCommand(command);
  const cmd = tokens[0];
  if (!cmd) return 'names no program';
  if (commandFamily(cmd) === 'npx') {
    if (tokens[1] !== '--no-install') return 'runs npx without --no-install as its first option';
    const tool = tokens[2];
    if (tool === undefined) return 'runs npx without a program';
    return NPX_STACK_TOOLS.has(commandFamily(tool))
      ? null
      : `requires a stack tool directly after npx --no-install (received ${tool})`;
  }
  if (isApprovedNpmRun(tokens, npmScriptsApproved)) {
    if (tokens[2] === undefined) return 'runs npm run without a script name';
    if (tokens.some((token) => SHELL_OPERATORS.test(token))) return 'contains a shell operator';
    return null;
  }
  if (cmd === 'test') return fileTestRefusal(tokens);
  return unsafeCommandReason(command);
}

export function checkCommandRefusal(
  command: string,
  {
    npmScriptsApproved,
    packageScripts,
  }: { npmScriptsApproved: boolean; packageScripts: PackageScriptsReadinessInput },
): string | null {
  const refusal = commandTextRefusal(command, npmScriptsApproved);
  const tokens = parseShellCommand(command);
  const script = tokens[2];
  if (refusal !== null || !isApprovedNpmRun(tokens, npmScriptsApproved) || script === undefined) {
    return refusal;
  }
  if (!packageScripts.packageJsonExists) {
    return 'runs an npm script, but package.json was not found';
  }
  if (!Object.hasOwn(packageScripts.scripts, script)) {
    return `runs the npm script ${script}, which package.json does not define`;
  }
  return null;
}

const REFUSED_WARNING = {
  category: 'validation',
  code: 'discovered_validation_refused',
} as const;

/** Why a test file pattern is refused, in the words of the rule it broke. */
function testPatternRefusal(pattern: string): string {
  return pattern.includes('..') ? 'it contains ".."' : 'it contains a path separator';
}

type TestResolutionContext = {
  projectDir: string;
  config: Config;
  manifest: ManifestCommands;
  stack: Stack | null;
};

export function sanitizeDiscoveredValidation(
  discovered: DiscoveredValidation | null | undefined,
  notices: { bus: EventBus; phase: Phase },
  resolution?: TestResolutionContext,
): DiscoveredValidation | undefined {
  if (!discovered) return undefined;

  const refuse = (message: string) =>
    publishWarning({
      bus: notices.bus,
      phase: notices.phase,
      message,
      safety: REFUSED_WARNING,
    });
  const sanitized: DiscoveredValidation = {};

  if (discovered.language) sanitized.language = discovered.language;
  if (discovered.testPattern) {
    if (isTestPatternSafe(discovered.testPattern)) {
      sanitized.testPattern = discovered.testPattern;
    } else {
      refuse(
        `The test checks do not take the file pattern ${discovered.testPattern} from the plan: ${testPatternRefusal(discovered.testPattern)}. They use config or the stack's test file patterns.`,
      );
    }
  }

  const value = discovered.testCommand;
  if (value) {
    const refusal = unsafeCommandReason(value);
    // A refusal empties only the discovered rung: config and the manifest outrank it and
    // the stack default follows it, so a test check may still run this very command.
    const resolved =
      refusal === null || resolution === undefined
        ? null
        : resolveTestCommand({ ...resolution, discovered: undefined });
    if (refusal === null) {
      sanitized.testCommand = value;
    } else if (
      resolved === null ||
      formatValidationCommand(resolved.cmd, resolved.args) !== value
    ) {
      refuse(
        `The test checks do not take ${value} from the plan: it ${refusal}. They use config, the manifest or the stack default.`,
      );
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}
