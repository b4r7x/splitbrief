import { parseShellCommand } from '../../../../utils/parse-shell-command.js';
import { npxScriptRefusal, packageScriptRefusal, programRefusal } from './program.js';
import {
  RUN_TEST_ALIASES,
  commandFamily,
  ALLOWED_COMMANDS,
  executedProgramPositions,
  SHELL_OPERATORS,
  isWorkspacePath,
  isWorkspaceFile,
  NPX_STACK_TOOLS,
} from './tables.js';

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

export function isApprovedNpmRun(tokens: string[], npmScriptsApproved: boolean): boolean {
  return npmScriptsApproved && commandFamily(tokens[0] ?? '') === 'npm' && tokens[1] === 'run';
}

/**
 * What the plan command policy refuses from the command text alone. Whether package.json defines
 * an npm script is `missingNpmScript`'s to say, since a task can add the script.
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
