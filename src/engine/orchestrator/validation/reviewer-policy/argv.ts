import { isAbsolute } from 'node:path';
import {
  NPM_VALUE_OPTIONS,
  PACKAGE_MANAGER_VALUE_OPTIONS,
  COMPOSER_VALUE_OPTIONS,
  type Forwarded,
  npmSubcommandAt,
  EXEC_DOWNLOAD_FLAGS,
  EXEC_CODE_FLAGS,
  npxProgram,
  FORWARDERS,
  packageManagerForwarded,
  UV_RUN_DOWNLOAD_FLAGS,
} from './package-managers.js';
import { PROJECT_WRAPPERS, lookup, isFlag, COMMAND_GROUPS } from './programs.js';

/** The build wrapper a first word names, by its exact spelling: `sub/gradlew` names none. */
export function projectWrapper(first: string): (typeof PROJECT_WRAPPERS)[string] | undefined {
  return lookup(PROJECT_WRAPPERS, first);
}

/** The words after the program, without the values of the package manager's value options. */
function argumentsWithoutValues(tokens: readonly string[]): string[] {
  const program = (tokens[0] ?? '').toLowerCase();
  const values =
    program === 'npm'
      ? NPM_VALUE_OPTIONS
      : program === 'pnpm' || program === 'yarn' || program === 'bun'
        ? PACKAGE_MANAGER_VALUE_OPTIONS
        : program === 'composer'
          ? COMPOSER_VALUE_OPTIONS
          : null;
  return tokens.slice(1).filter((_, index) => values?.has(tokens[index] ?? '') !== true);
}

/** The words after the program that are not options, nor package manager option values. */
export function operands(tokens: readonly string[]): string[] {
  return argumentsWithoutValues(tokens).filter((token) => !isFlag(token));
}

/**
 * An argument naming a place outside the run workspace: an absolute path or a `..` segment, also as
 * the value after `=` (`--prefix=/x`, `DESTDIR=/`) or attached to a short option (`-o/tmp/x`).
 */
export function leavesWorkspace(token: string): boolean {
  const values = [
    token,
    token.slice(token.indexOf('=') + 1),
    /^-[A-Za-z]./s.test(token) ? token.slice(2) : token,
  ];
  return values.some((value) => isAbsolute(value) || value.split(/[\\/]/).includes('..'));
}

/** The command line npx, npm exec, a forwarder's subcommand, pnpm or yarn hands on. */
export function forwarded(tokens: readonly string[]): Forwarded | null {
  const program = (tokens[0] ?? '').toLowerCase();
  const exec = npmSubcommandAt(tokens, ['exec', 'x']);
  if (program === 'npx' || exec !== -1) {
    const name = program === 'npx' ? 'npx' : 'npm exec';
    const start = program === 'npx' ? 1 : exec + 1;
    const own = tokens.slice(start);
    const toolIndex = own.findIndex((token) => !isFlag(token));
    const flags = toolIndex === -1 ? own : own.slice(0, toolIndex);
    if (program === 'npx' ? tokens[1] !== '--no-install' : !flags.includes('--no-install')) {
      return {
        refusal:
          program === 'npx'
            ? 'runs npx without --no-install as its first option'
            : 'runs npm exec without --no-install',
      };
    }
    const download = flags.find((flag) => EXEC_DOWNLOAD_FLAGS.has(flag.replace(/=.*$/s, '')));
    if (download !== undefined) {
      return {
        refusal: `runs ${name} with ${download.replace(/=.*$/s, '')}, which downloads a missing package`,
      };
    }
    const code = flags.find((flag) => EXEC_CODE_FLAGS.has(flag.replace(/=.*$/s, '')));
    if (code !== undefined) {
      return { refusal: `uses the code-loading option ${name} ${code.replace(/=.*$/s, '')}` };
    }
    const tool = own[toolIndex];
    if (tool === undefined) return { refusal: `runs ${name} without a program` };
    return { commands: [[npxProgram(tool), ...own.slice(toolIndex + 1)]] };
  }
  const subs = lookup(FORWARDERS, program) ?? [];
  const at = tokens.findIndex((token, index) => index > 0 && subs.includes(token));
  if (at === -1) {
    return program === 'pnpm' || program === 'yarn' ? packageManagerForwarded(tokens) : null;
  }
  const sub = tokens[at];
  const rest = tokens.slice(at + 1);
  if (rest[0] === '--') return { commands: [rest.slice(1)] };
  // mise installs the tools named before `--` and runs a shell when no program follows it.
  if (program === 'mise')
    return { refusal: `runs ${program} ${sub} without -- before its program` };
  if (program === 'uv') {
    const download = rest.find(
      (token) => UV_RUN_DOWNLOAD_FLAGS.has(token.replace(/=.*$/s, '')) || /^-w./s.test(token),
    );
    if (download !== undefined) {
      const option = /^-w./s.test(download) ? '-w' : download.replace(/=.*$/s, '');
      return { refusal: `has ${option} after uv run, where it can download a package` };
    }
  }
  return {
    commands: leadingOperands(rest).map((index) => {
      const token = rest[index] ?? '';
      // hatch runs `<environment>:<command>` in that environment.
      const first = program === 'hatch' ? token.slice(token.lastIndexOf(':') + 1) : token;
      return [first, ...rest.slice(index + 1)];
    }),
  };
}

/** A word after which a program runs a script or another program, which the walk does not read. */
export function handsOn(program: string, token: string): boolean {
  if (program === 'npx' || token === 'run' || token === 'run-script') return true;
  if (program === 'npm' && (token === 'exec' || token === 'x')) return true;
  return lookup(FORWARDERS, program)?.includes(token) === true;
}

/**
 * The indexes of the operands that can name what a command runs. An operand after an option can be
 * the option's value (`go -C . generate`, `uv run --python 3.12 pytest`), so the walk ends at the
 * first operand that follows no option; `--option=value` holds its own value. An operand that
 * `takesMore` names (a command group: `go -C . mod tidy`) does not end the walk.
 */
function leadingOperands(
  args: readonly string[],
  takesMore: (operand: string) => boolean = () => false,
): number[] {
  const indexes: number[] = [];
  for (const [index, token] of args.entries()) {
    if (isFlag(token)) continue;
    indexes.push(index);
    const previous = args[index - 1];
    const followsOption = previous !== undefined && isFlag(previous) && !previous.includes('=');
    if (!followsOption && !takesMore(token)) break;
  }
  return indexes;
}

/**
 * The operands that can name a program's subcommand. The walk ends before a word that hands on to
 * a script or program (`npm --silent run update`): the forwarded walk checks those.
 */
export function subcommandWords(tokens: readonly string[]): string[] {
  const program = (tokens[0] ?? '').toLowerCase();
  const args = argumentsWithoutValues(tokens);
  const words: string[] = [];
  for (const index of leadingOperands(args, (token) => COMMAND_GROUPS.has(token))) {
    const token = args[index] ?? '';
    if (handsOn(program, token)) break;
    words.push(token);
  }
  return words;
}
