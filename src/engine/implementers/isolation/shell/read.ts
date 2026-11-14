import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { ASSIGNMENT } from './args.js';
import { COMMANDS } from './commands.js';
import { readsArguments } from './file-commands.js';
import { OPAQUE, HOME_MARK, PWD_MARK, TMPDIR_MARK, lexShell } from './lexer.js';
import type { PathScope, PathReference, ShellContext, ShellReading } from './types.js';

// A substitution, an unknown variable or a glob ends what a word says for certain.
const UNCERTAIN = [OPAQUE, '*', '?', '[', '{'];
const MAX_NESTING = 8;
/** Words that open or continue a compound command; the command itself follows them. */
const LEADING_KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'do',
  'while',
  'until',
  '!',
  '{',
  '}',
]);

/**
 * `word` made absolute against `base`, each `..` taken the way the kernel takes it: from
 * where the directory before it really is. Under a linked `node_modules`,
 * `node_modules/../src` names the `src` beside what the link points at. A `..` after a
 * directory that does not exist drops it by name, since nothing is reached through it.
 */
export function resolveFollowingLinks(base: string, word: string): string {
  let path: string = sep;
  for (const segment of (isAbsolute(word) ? word : `${base}${sep}${word}`).split(sep)) {
    if (segment === '..') path = dirname(existsSync(path) ? realpathSync(path) : path);
    else if (segment !== '' && segment !== '.') path = join(path, segment);
  }
  return path;
}

/** What a word says for certain, its marks expanded; null when it names no path. */
function certainText(word: string, scope: PathScope, cwd: string): string | null {
  const text = word
    .replaceAll(HOME_MARK, scope.home)
    .replaceAll(PWD_MARK, cwd)
    .replaceAll(TMPDIR_MARK, scope.tmpdir ?? OPAQUE);
  const cut = Math.min(
    ...UNCERTAIN.map((marker) => text.indexOf(marker)).filter((at) => at !== -1),
    text.length,
  );
  const certain = text.slice(0, cut);
  if (certain === '' || certain.startsWith('-') || certain.includes('://')) return null;
  return certain;
}

function resolveWord(word: string, scope: PathScope, cwd: string): string | null {
  const certain = certainText(word, scope, cwd);
  return certain === null ? null : resolveFollowingLinks(cwd, certain);
}

function analyzeWords(
  words: readonly string[],
  scope: PathScope,
  state: { cwd: string },
  out: PathReference[],
  depth: number,
): void {
  const start = words.findIndex((word) => !ASSIGNMENT.test(word) && !LEADING_KEYWORDS.has(word));
  if (start === -1) return;
  const [name, ...args] = words.slice(start);
  if (name === undefined) return;
  const ctx: ShellContext = {
    state,
    chdir: (word, how) => {
      const certain = certainText(word, scope, state.cwd);
      if (certain === null) return;
      state.cwd =
        how === 'by-name' ? resolve(state.cwd, certain) : resolveFollowingLinks(state.cwd, certain);
      out.push({ path: state.cwd, access: 'read', followsLink: true });
    },
    add: (word, access, followsLink = true) => {
      const path = resolveWord(word, scope, state.cwd);
      // A word cut at a glob names what the glob expands under: `rm -rf node_modules/*`
      // empties the directory the link points at, not the link.
      const cut = UNCERTAIN.some((marker) => word.includes(marker));
      if (path !== null) out.push({ path, access, followsLink: followsLink || cut });
    },
    mention: (word) => {
      const path = resolveWord(word, scope, state.cwd);
      // A lone `/` is a delimiter far more often than the root: `cut -d /`, `tr / _`.
      if (path !== null && path !== sep) {
        out.push({ path, access: 'read', followsLink: true, mentioned: true });
      }
    },
    changesPackages: (dir) => {
      const path = resolveWord(`${dir}${sep}node_modules`, scope, state.cwd);
      if (path !== null) {
        out.push({ path, access: 'write', followsLink: true, changesPackages: true });
      }
    },
    words: (argv) => {
      if (depth < MAX_NESTING) analyzeWords(argv, scope, state, out, depth + 1);
    },
    script: (source) => {
      if (depth < MAX_NESTING) collect(source, { ...scope, cwd: state.cwd }, out, depth + 1);
    },
  };
  if (name.includes('/')) ctx.mention(name);
  (COMMANDS[basename(name)] ?? readsArguments)(args, ctx);
}

/** Reads `source` into `out`; returns the working directory the script leaves its shell in. */
function collect(source: string, scope: PathScope, out: PathReference[], depth: number): string {
  const { commands, nested } = lexShell(source);
  const state = { cwd: scope.cwd };
  for (const command of commands) {
    for (const redirect of command.redirects) {
      const path = resolveWord(redirect.target, scope, state.cwd);
      if (path !== null) out.push({ path, access: redirect.access, followsLink: true });
    }
    analyzeWords(command.words, scope, state, out, depth);
  }
  for (const inner of nested) {
    if (depth < MAX_NESTING) collect(inner, scope, out, depth + 1);
  }
  return state.cwd;
}

/**
 * Every path a shell command line names, with how the command reaches it, and
 * the directory a `cd` in it leaves the shell in.
 * Only what the line says for certain counts: a glob, a substitution or an
 * unknown variable ends a word, so `/Users/me/*` reaches `/Users/me` and
 * `$(pwd)/x` reaches nothing this reading can name.
 */
export function readShellCommand(command: string, scope: PathScope): ShellReading {
  const references: PathReference[] = [];
  const cwd = collect(command, scope, references, 0);
  return { references, cwd };
}
