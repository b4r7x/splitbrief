import { executableName } from './interpreter-command-string.js';

const NPM_EXEC_SUBCOMMANDS = new Set(['exec', 'x']);

// npm's `--call` option and its shorthands. `nopt` resolves `-c` and `--c` to the same key, so
// `-c=<string>` and `--c[=<string>]` name the command-string option as well.
export function isCallOption(arg: string): boolean {
  return (
    arg === '--call' ||
    arg.startsWith('--call=') ||
    arg === '--c' ||
    arg.startsWith('--c=') ||
    arg.startsWith('-c=')
  );
}

// npm value-taking options confirmed against installed npm 10 `@npmcli/config`: a following
// non-option token is this option's value, not the subcommand. Reading these deterministically
// keeps the accepted `npm --call exec` control, where `exec` is the option value.
const NPM_VALUE_OPTIONS = new Set([
  '--cache',
  '--call',
  '--c',
  '--globalconfig',
  '--loglevel',
  '--prefix',
  '--registry',
  '--userconfig',
  '--workspace',
  '-w',
]);

// npm runs the first positional token `nopt` leaves after parsing options across argv; the option
// region ends at `--`, and the tokens after it are positional as well. An option outside the value
// list above may still take a value, so both readings are explored: the next token is either its
// value or the first positional. Every reading that makes exec/x the subcommand leaves an earlier
// `--call` live, because the option lives inside one argv token and the digest cannot follow it.
function npmExecIsPossibleSubcommand(args: readonly string[]): boolean {
  const pending = [0];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const index = pending.pop();
    if (index === undefined || seen.has(index)) continue;
    seen.add(index);
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === '--') {
      const positional = args[index + 1];
      if (positional !== undefined && NPM_EXEC_SUBCOMMANDS.has(positional)) return true;
      continue;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      if (NPM_EXEC_SUBCOMMANDS.has(arg)) return true;
      continue;
    }
    if (arg.includes('=')) {
      pending.push(index + 1);
      continue;
    }
    if (NPM_VALUE_OPTIONS.has(arg)) {
      const value = args[index + 1];
      pending.push(value !== undefined && !value.startsWith('-') ? index + 2 : index + 1);
      continue;
    }
    // Unknown option: npm reads it as Boolean or takes the next non-option token as its value.
    pending.push(index + 1);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('-')) pending.push(index + 2);
  }
  return false;
}

// `--` ends npm's option region: every later token is a positional or a literal child argument.
function npmOptionBoundaryIndex(args: readonly string[]): number {
  const boundary = args.indexOf('--');
  return boundary === -1 ? args.length : boundary;
}

// Value-taking npx option keys, mirroring installed npm 10 `bin/npx-cli.js`: the scan skips the
// next argv token for each one, whether or not that token looks like an option.
const NPX_VALUE_OPTION_KEYS = new Set([
  'package',
  'p',
  'cache',
  'userconfig',
  'call',
  'c',
  'shell',
  'npm',
  'node-arg',
  'n',
]);

// npx skips the token after every other option whose key is not one of npm's Boolean switches; a
// Boolean switch leaves the next token as the positional child command. The first group mirrors
// the switch keys installed npm 10 `bin/npx-cli.js` derives from `@npmcli/config`; the second adds
// npx's own switches and the shorthands whose expansion carries its value, where skipping the next
// token would wrongly consume the child command. A name missing here only makes the scan stricter.
const NPX_BOOLEAN_SWITCH_KEYS = new Set([
  'all',
  'allow-same-version',
  'audit',
  'bin-links',
  'browser',
  'color',
  'commit-hooks',
  'description',
  'dev',
  'diff-ignore-all-space',
  'diff-name-only',
  'diff-no-prefix',
  'diff-text',
  'dry-run',
  'engine-strict',
  'expect-results',
  'force',
  'foreground-scripts',
  'format-package-lock',
  'fund',
  'git-tag-version',
  'global',
  'global-style',
  'if-present',
  'ignore-scripts',
  'include-staged',
  'include-workspace-root',
  'install-links',
  'json',
  'legacy-bundling',
  'legacy-peer-deps',
  'link',
  'long',
  'offline',
  'omit-lockfile-registry-resolved',
  'optional',
  'package-lock',
  'package-lock-only',
  'parseable',
  'prefer-dedupe',
  'prefer-offline',
  'prefer-online',
  'production',
  'progress',
  'provenance',
  'read-only',
  'rebuild-bundle',
  'save',
  'save-bundle',
  'save-dev',
  'save-exact',
  'save-optional',
  'save-peer',
  'save-prod',
  'shrinkwrap',
  'sign-git-commit',
  'sign-git-tag',
  'strict-peer-deps',
  'strict-ssl',
  'timing',
  'unicode',
  'update-notifier',
  'usage',
  'version',
  'versions',
  'workspaces',
  'workspaces-update',
  'yes',
  'no-install',
  'quiet',
  'q',
  'v',
  'help',
  'h',
  'always-spawn',
  'ignore-existing',
  'shell-auto-fallback',
  'silent',
  'verbose',
  'd',
  'dd',
  'ddd',
  's',
  'y',
  'f',
  'g',
  'S',
  'B',
  'D',
  'E',
  'O',
  'P',
  'l',
  'a',
  'ws',
  'iwr',
  'local',
  'readonly',
  'porcelain',
  'desc',
  'no',
  'H',
  '?',
]);

// npx reads only leading options: it stops at `--` or the first positional command, inserts `--`
// before that command, and hands the rest to it, where `--call` is a literal child argument.
function npxOptionPrefixLength(args: readonly string[]): number {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === undefined || arg === '--' || arg === '-' || !arg.startsWith('-')) break;
    index += 1;
    if (arg.includes('=')) continue;
    const key = arg.replace(/^-+/, '');
    const next = args[index];
    if (NPX_VALUE_OPTION_KEYS.has(key)) {
      index += 1;
    } else if (!NPX_BOOLEAN_SWITCH_KEYS.has(key) && next !== undefined && !next.startsWith('-')) {
      index += 1;
    }
  }
  return index;
}

// `npx` and `npm exec` (also spelled `npm x`) run the command string a `--call` option names.
// The command lives inside one argv token, so the trust digest cannot follow the package script
// it reaches; refusing the option keeps a receipt bound to everything such a hook runs.
export function isOwnCallOption(command: string, args: readonly string[], index: number): boolean {
  const name = executableName(command);
  if (name === 'npx') return index < npxOptionPrefixLength(args);
  if (name !== 'npm') return false;
  return npmExecIsPossibleSubcommand(args) && index < npmOptionBoundaryIndex(args);
}
