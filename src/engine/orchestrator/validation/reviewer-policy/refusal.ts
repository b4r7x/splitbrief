import { parseShellCommand } from '../../../../utils/parse-shell-command.js';
import { packageScript } from './definition.js';
import { operands, subcommandWords, projectWrapper, leavesWorkspace, forwarded } from './argv.js';
import { interpreterCall } from './interpreter.js';
import { npmSubcommandAt, APPLICATION_SCRIPTS } from './package-managers.js';
import {
  BARE_INSTALLERS,
  GOAL_RUNNERS,
  SETUP_VERBS,
  lookup,
  SCOPED_SETUP_VERBS,
  COMMAND_GROUPS,
  LAUNCHERS,
  TASK_RUNNERS,
  isFlag,
  MAKE_CONTROL_VARIABLES,
  TASK_CODE_GOALS,
  CONTROL_CHARACTER,
  SHELL_SYNTAX,
  REMOTE,
  SHELLS,
  WRAPPERS,
  NOT_VERIFICATION,
  PACKAGE_MUTATIONS,
  FIND_ACTIONS,
} from './programs.js';

function setupRefusal(program: string, tokens: readonly string[]): string | null {
  if (operands(tokens).length === 0) {
    return BARE_INSTALLERS.has(program) ? `runs ${program} with no argument, which installs` : null;
  }
  const checked = GOAL_RUNNERS.has(program) ? operands(tokens) : subcommandWords(tokens);
  const at = checked.findIndex(
    (word) =>
      SETUP_VERBS.has(word) && (lookup(SCOPED_SETUP_VERBS, word)?.includes(program) ?? true),
  );
  if (at === -1) return null;
  const group = GOAL_RUNNERS.has(program) ? [] : checked.slice(at - 1, at);
  const named = [...group.filter((word) => COMMAND_GROUPS.has(word)), ...checked.slice(at, at + 1)];
  return `runs a setup command (${[program, ...named].join(' ')})`;
}

function launcherRefusal(program: string, tokens: readonly string[]): string | null {
  const words = [program, ...operands(tokens)];
  const launcher = LAUNCHERS.find((pattern) =>
    pattern.every((word, index) => words[index] === word),
  );
  if (launcher !== undefined) return `downloads and runs a package (${launcher.join(' ')})`;
  if (program === 'go' && words[1] === 'run' && words.slice(2).some((word) => word.includes('@'))) {
    return 'downloads and runs a package (go run <package>@<version>)';
  }
  return null;
}

const TASK_OPTION_KINDS = ['code', 'definition'] as const;

/** Whether a token is a build or task runner's option that takes code or reads another definition. */
function taskRunnerOption(
  program: string,
  token: string,
): { kind: (typeof TASK_OPTION_KINDS)[number]; option: string } | undefined {
  const runner = lookup(TASK_RUNNERS, program);
  if (runner === undefined || !isFlag(token)) return undefined;
  const long = (option: string) => option.startsWith('--');
  if (token.startsWith('--')) {
    // getopt and OptionParser take an unambiguous prefix of a long option: `--ev` is `--eval`.
    const name = token.replace(/=.*$/s, '');
    if (name.length <= 2) return undefined;
    const kind = TASK_OPTION_KINDS.find((kind) =>
      runner[kind].some((option) => long(option) && option.startsWith(name)),
    );
    return kind === undefined ? undefined : { kind, option: name };
  }
  if (runner.valueLetters === null) {
    for (const kind of TASK_OPTION_KINDS) {
      const option = runner[kind].find((option) => !long(option) && token.startsWith(option));
      if (option !== undefined) return { kind, option };
    }
    return undefined;
  }
  for (const letter of token.slice(1)) {
    const kind = TASK_OPTION_KINDS.find((each) => runner[each].includes(`-${letter}`));
    if (kind !== undefined) return { kind, option: `-${letter}` };
    if (runner.valueLetters.includes(letter)) return undefined;
  }
  return undefined;
}

/** A `make` operand that sets the shell, its flags, the makefiles or make's options, or runs code. */
function makeVariableRefusal(tokens: readonly string[]): string | null {
  for (const token of operands(tokens)) {
    const assignment = /^\s*([^\s:+?!=]+)\s*(:{0,3}|[+?!])=/.exec(token);
    if (assignment === null) continue;
    const name = assignment[1] ?? '';
    if (assignment[2] === '!') return `uses the make shell assignment operator != for ${name}`;
    if (MAKE_CONTROL_VARIABLES.has(name)) return `sets the make variable ${name}`;
  }
  return null;
}

function taskRunnerRefusal(program: string, tokens: readonly string[]): string | null {
  const variable = program === 'make' ? makeVariableRefusal(tokens) : null;
  if (variable !== null) return variable;
  const goals = lookup(TASK_CODE_GOALS, program);
  const words = operands(tokens);
  const goal = (GOAL_RUNNERS.has(program) ? words : words.slice(0, 1)).find((word) =>
    goals?.some((goal) => (goal.endsWith(':') ? word.startsWith(goal) : word === goal)),
  );
  if (goal !== undefined) {
    return `runs the code-execution goal ${program} ${goal}`;
  }
  for (const token of tokens.slice(1)) {
    const option = taskRunnerOption(program, token);
    if (option?.kind === 'code') return `uses the code-loading option ${program} ${option.option}`;
    if (option?.kind === 'definition')
      return `uses the definition-changing option ${program} ${option.option}`;
  }
  return null;
}

/** `mix do a x + b y` (or `a x, b y`) runs each task in turn, so each is checked as its own `mix`. */
function mixTasksRefusal(tokens: readonly string[]): string | null {
  const tasks: string[][] = [];
  let task: string[] = [];
  for (const token of tokens.slice(tokens.indexOf('do') + 1)) {
    if (token === '+' || token.endsWith(',')) {
      tasks.push(token === '+' ? task : [...task, token.slice(0, -1)]);
      task = [];
      continue;
    }
    task.push(token);
  }
  tasks.push(task);
  for (const each of tasks) {
    const refusal = tokensRefusal(['mix', ...each]);
    if (refusal !== null) return refusal;
  }
  return null;
}

function tokensRefusal(tokens: readonly string[]): string | null {
  const first = tokens[0];
  if (first === undefined || first === '') return 'names no program';
  if (tokens.some((token) => CONTROL_CHARACTER.test(token))) return 'contains a control character';
  if (tokens.some((token) => SHELL_SYNTAX.test(token))) return 'contains a shell operator';
  if (first.includes('=')) return 'sets an environment variable before the program';
  const wrapper = projectWrapper(first);
  if (wrapper !== undefined) return tokensRefusal([wrapper.tool, ...tokens.slice(1)]);
  if (first.includes('/') || first.includes('\\')) return 'runs a program by path';
  if (tokens.some((token) => REMOTE.test(token))) return 'names a URL or a remote package';
  if (tokens.some(leavesWorkspace)) return 'names a path outside the run workspace';
  const program = first.toLowerCase();
  if (program === 'cd') return 'changes the directory';
  if (SHELLS.has(program)) return `runs the shell ${program}`;
  if (WRAPPERS.has(program)) return `runs another command line through ${program}`;
  if (npmSubcommandAt(tokens, ['explore']) !== -1) {
    return 'runs another command line through npm explore';
  }
  if (NOT_VERIFICATION.has(program)) return `runs ${program}, which does not verify a change`;
  const words = operands(tokens);
  const mutations = lookup(PACKAGE_MUTATIONS, program);
  const mutation = mutations?.find((sub) => words[0] === sub);
  if (mutation !== undefined) return `runs ${program} ${mutation}, which changes package state`;
  if (
    mutations !== undefined &&
    words[0] === 'audit' &&
    tokens.slice(1).some((token) => token === 'fix' || token.replace(/=.*$/s, '') === '--fix')
  ) {
    return `runs a setup command (${program} audit fix)`;
  }
  const action = program === 'find' ? tokens.find((token) => FIND_ACTIONS.has(token)) : undefined;
  if (action !== undefined) return `runs find ${action}, which changes files or runs commands`;
  if (program === 'mix' && words[0] === 'do') return mixTasksRefusal(tokens);
  const call = interpreterCall(tokens);
  if (call?.kind === 'refused') return call.reason;
  if (call?.kind === 'module') return tokensRefusal(call.command);
  const refusal =
    taskRunnerRefusal(program, tokens) ??
    launcherRefusal(program, tokens) ??
    setupRefusal(program, tokens);
  if (refusal !== null) return refusal;
  const script = packageScript(tokens);
  if (
    script?.kind === 'package-script' &&
    script.manifest === 'package.json' &&
    APPLICATION_SCRIPTS.has(script.script)
  ) {
    return `runs the package script ${script.script}, which starts or stops the application and does not verify a change`;
  }
  const next = forwarded(tokens);
  if (next === null) return null;
  if ('refusal' in next) return next.refusal;
  for (const candidate of next.commands) {
    const refusal = tokensRefusal(candidate);
    if (refusal !== null) return refusal;
  }
  return null;
}

/**
 * Why SPLITBRIEF does not run a gate command or a fix check's reviewer command, or null when it runs. The policy
 * admits any installed program of any stack and refuses only what is not a verification: shell
 * syntax, programs run by path, inline code, downloads, setup commands and other command lines.
 */
export function reviewerCommandRefusal(command: string): string | null {
  return tokensRefusal(parseShellCommand(command));
}
