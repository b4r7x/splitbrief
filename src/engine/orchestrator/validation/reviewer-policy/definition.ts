import { posix } from 'node:path';
import { parseShellCommand } from '../../../../utils/parse-shell-command.js';
import { operands, handsOn, projectWrapper, forwarded } from './argv.js';
import { interpreterCall } from './interpreter.js';
import {
  DIRECTORY_OPTIONS,
  APPLICATION_SCRIPTS,
  packageManagerWord,
  PACKAGE_MANAGER_COMMANDS,
} from './package-managers.js';
import { lookup, TASK_FILES } from './programs.js';

/** The project file or files that define what a check runs. */
export type CheckDefinition =
  | { kind: 'script-file'; file: string }
  | {
      kind: 'package-script';
      runner: string;
      manifest: 'package.json' | 'composer.json';
      script: string;
      /** The directory a directory option names (`npm --prefix sub`), or `.`. */
      dir: string;
    }
  | { kind: 'task-file'; runner: string; files: readonly string[]; dirs: readonly string[] }
  | { kind: 'wrapper'; runner: string; files: readonly string[]; dirs: readonly string[] };

/** The directory the last directory option before `--` names, posix-normalized, or `.`. */
function directoryOf(runner: string, tokens: readonly string[]): string {
  const options = lookup(DIRECTORY_OPTIONS, runner) ?? [];
  let dir = '.';
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    if (token === '--') break;
    const name = token.replace(/=.*$/s, '');
    if (options.includes(name)) {
      dir = name === token ? (tokens[++index] ?? '.') : token.slice(name.length + 1);
    } else if (/^-[A-Za-z]./s.test(token) && options.includes(token.slice(0, 2))) {
      dir = token.slice(2);
    }
  }
  return posix.join(dir, '.');
}

/** The package script npm, pnpm, yarn, bun or composer runs, when the command runs one. */
export function packageScript(tokens: readonly string[]): CheckDefinition | null {
  const runner = (tokens[0] ?? '').toLowerCase();
  const defined = (script: string | undefined): CheckDefinition | null =>
    script === undefined
      ? null
      : {
          kind: 'package-script',
          runner,
          manifest: runner === 'composer' ? 'composer.json' : 'package.json',
          script,
          dir: directoryOf(runner, tokens),
        };
  if (runner === 'npm' || runner === 'composer') {
    const [sub, name] = operands(tokens);
    if (sub === 'run' || sub === 'run-script') return defined(name);
    // `composer exec <program>` runs a program, not a script: the forwarded walk names it.
    if (runner === 'composer') {
      return sub !== undefined && handsOn(runner, sub) ? null : defined(sub);
    }
    if (sub === 'test' || sub === 't') return defined('test');
    return defined(sub !== undefined && APPLICATION_SCRIPTS.has(sub) ? sub : undefined);
  }
  if (runner !== 'pnpm' && runner !== 'yarn' && runner !== 'bun') return null;
  const word = packageManagerWord(tokens);
  if (word === null) return null;
  const script = tokens[word.index] ?? '';
  if (word.afterRun) return defined(script);
  // `bun test` and `bun build` are bun's own test runner and bundler; `bun run <name>` runs a script.
  if (script === 'test' || script === 't') return defined(runner === 'bun' ? undefined : 'test');
  if (runner === 'bun' && script === 'build') return null;
  if (APPLICATION_SCRIPTS.has(script)) return defined(script);
  if (PACKAGE_MANAGER_COMMANDS.has(script)) return null;
  // A bare word can resolve to a package script even with syntax-check arguments.
  return definitionOf(tokens.slice(word.index)) ?? defined(script);
}

function definitionOf(tokens: readonly string[]): CheckDefinition | null {
  const call = interpreterCall(tokens);
  if (call?.kind === 'script') return { kind: 'script-file', file: posix.normalize(call.file) };
  if (call !== null) return null;
  const first = tokens[0] ?? '';
  const wrapper = projectWrapper(first);
  if (wrapper !== undefined) {
    return { kind: 'wrapper', runner: first, files: wrapper.files, dirs: wrapper.dirs };
  }
  const script = packageScript(tokens);
  if (script !== null) return script;
  const program = first.toLowerCase();
  const task = lookup(TASK_FILES, program);
  if (task !== undefined) return { kind: 'task-file', runner: program, ...task };
  const next = forwarded(tokens);
  if (next === null || 'refusal' in next) return null;
  for (const candidate of next.commands) {
    const definition = definitionOf(candidate);
    if (definition !== null) return definition;
  }
  return null;
}

/**
 * The project file or files that define what a command runs: an interpreter script, a package
 * script, a task file or a build wrapper, looking through `npx`, `bundle exec`, `uv run` and the
 * like. Null when the command runs none.
 */
export function checkDefinition(command: string): CheckDefinition | null {
  return definitionOf(parseShellCommand(command));
}
