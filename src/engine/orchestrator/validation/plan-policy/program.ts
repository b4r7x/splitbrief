import { isPackageManager } from '../../../../core/trust/package-scripts.js';
import { isTestScript } from '../../../../core/validation/stacks/registry.js';
import {
  nodeParsesOnly,
  INLINE_CODE_FLAGS,
  CODE_LOAD_FLAGS,
  NODE_SYNTAX_CHECK_FLAGS,
  NODE_TEST_BOOLEAN_FLAGS,
  NODE_TEST_VALUE_FLAGS,
  NODE_TEST_REPORTERS,
} from '../interpreter-flags.js';
import {
  commandFamily,
  isWorkspacePath,
  isWorkspaceFile,
  NODE_TEST_STACKS,
  PYTHON_TOOLS,
  isPathLikeScriptArg,
  NPX_CODE_LOAD_PACKAGES,
  NPM_SCRIPT_SUBCOMMANDS,
  PNPM_SCRIPT_SUBCOMMANDS,
  YARN_SCRIPT_SUBCOMMANDS,
  STAGE_TARGETS,
  INTERPRETERS,
  TASK_RUNNERS,
  RUN_FRONT_ENDS,
  TEST_CONFIG_FLAGS,
} from './tables.js';

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

export function npxScriptRefusal(tokens: string[]): string | null {
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

export function packageScriptRefusal(tokens: string[]): string | null {
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

export function programRefusal(tokens: string[], positions: number[]): string | null {
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
