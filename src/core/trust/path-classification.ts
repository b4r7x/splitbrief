import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isInsideRoot } from '../../lib/path-confinement.js';
import { resolveBareCommandOnPath } from '../../lib/process/command-path.js';
import { readPackageJson } from '../project-meta.js';
import { parseShellCommand } from '../../utils/parse-shell-command.js';
import { executableName } from './interpreter-command-string.js';

const CODE_LOADING_INTERPRETERS = new Set([
  'node',
  'nodejs',
  'python',
  'ruby',
  'perl',
  'php',
  'npx',
  'tsx',
  'ts-node',
  'nodemon',
  'bun',
  'deno',
]);

const NODE_INTERPRETERS = new Set(['node', 'nodejs']);

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// yarn installs `yarnpkg` as a second name; `isPackageManager` keeps its pinned policy, so the
// alias applies only where a script is read.
const PACKAGE_MANAGER_ALIASES = new Map([['yarnpkg', 'yarn']]);
// npm resolves a command through its aliases and any unique prefix, and reads camelCase as
// kebab-case, so `rum`, `ur`, `run-s` and `runS` all name `run-script`.
const NPM_RUN_ALIASES = new Set(['run', 'rum', 'urn', 'ur']);
const NPM_LIFECYCLE_ALIASES = new Map([
  ['test', 'test'],
  ['t', 'test'],
  ['tst', 'test'],
  ['tes', 'test'],
  ['start', 'start'],
  ['stop', 'stop'],
  ['sto', 'stop'],
  ['restart', 'restart'],
  ['restar', 'restart'],
  ['resta', 'restart'],
  ['rest', 'restart'],
  ['res', 'restart'],
  // npm install and its aliases (`npm i`, `npm add`, the `isntall` typos) plus `npm ci` all run
  // the root install lifecycle scripts (docs.npmjs.com/cli/v11/using-npm/scripts).
  ['install', 'install'],
  ['i', 'install'],
  ['in', 'install'],
  ['ins', 'install'],
  ['inst', 'install'],
  ['insta', 'install'],
  ['instal', 'install'],
  ['isnt', 'install'],
  ['isnta', 'install'],
  ['isntal', 'install'],
  ['isntall', 'install'],
  ['add', 'install'],
  ['ci', 'install'],
  ['clean-install', 'install'],
  ['ic', 'install'],
  ['install-clean', 'install'],
  ['isntall-clean', 'install'],
]);
const INLINE_PROGRAM_FLAGS = new Map<string, ReadonlySet<string>>([
  ['node', new Set(['-e', '--eval', '-p', '--print'])],
  ['nodejs', new Set(['-e', '--eval', '-p', '--print'])],
  ['python', new Set(['-c'])],
  ['ruby', new Set(['-e'])],
  ['perl', new Set(['-e', '-E'])],
  ['php', new Set(['-r'])],
  ['tsx', new Set(['-e', '--eval'])],
  ['ts-node', new Set(['-e', '--eval'])],
  ['bun', new Set(['-e', '--eval'])],
]);

export function isPathLike(token: string): boolean {
  if (token.includes('/') || token.includes('\\')) return true;
  return /^[a-zA-Z0-9_.-]+[\\/][a-zA-Z0-9_.\\/-]+$/.test(token);
}

export function isRepoLocal(token: string, projectDir: string): boolean {
  if (token.startsWith('./') || token.startsWith('../')) return true;
  if (token.startsWith('/')) {
    return isInsideRoot(resolve(projectDir), resolve(token));
  }
  if (isPathLike(token)) return true;
  return false;
}

export function commandTokensAfterInterpreter(tokens: readonly string[]): readonly string[] {
  const interpreter = tokens[0] ?? '';
  const name = interpreterName(interpreter);
  if (!CODE_LOADING_INTERPRETERS.has(name) || tokens.length <= 1) return tokens;
  return interpreterPathTokens(name, tokens.slice(1));
}

// The operands of the first interpreter anywhere in the argv: `yarn tsx check.ts` and
// `timeout 5 node check.mjs` run their file as `node check.mjs` does.
export function interpreterOperands(tokens: readonly string[]): readonly string[] {
  const at = tokens.findIndex((token) => CODE_LOADING_INTERPRETERS.has(interpreterName(token)));
  if (at === -1) return [];
  return interpreterPathTokens(interpreterName(tokens[at] ?? ''), tokens.slice(at + 1));
}

// The operands of the first node interpreter anywhere in the argv. Node resolves its entry point
// the way require() does; the other code-loading interpreters name their file exactly, so only
// node/nodejs run a file the operand does not spell literally.
export function nodeEntryPointOperands(tokens: readonly string[]): readonly string[] {
  const at = tokens.findIndex((token) => NODE_INTERPRETERS.has(interpreterName(token)));
  if (at === -1) return [];
  return interpreterPathTokens(interpreterName(tokens[at] ?? ''), tokens.slice(at + 1));
}

export function commandName(command: string): string {
  const executable = parseShellCommand(command)[0] ?? command;
  return executableName(executable);
}

// `npm@10` and `tsx@4` name the registry packages whose binaries are `npm` and `tsx`.
function withoutPackageSpec(command: string): string {
  const name = commandName(command);
  return name.startsWith('@') ? name : name.replace(/@[^@]*$/, '');
}

// The free-threaded `python3.13t`, the windowed `pythonw` and `pypy3` all run the Python
// interpreter.
const PYTHON_NAME = /^(?:pythonw?|pypy)\d*(?:\.\d+)*t?$/;

// A versioned binary such as `python3.13` or `perl5.34` runs the interpreter it names.
function interpreterName(command: string): string {
  const name = withoutPackageSpec(command);
  if (PYTHON_NAME.test(name)) return 'python';
  return name.replace(/\d+(\.\d+)*$/, '');
}

function interpreterPathTokens(interpreter: string, tokens: readonly string[]): string[] {
  const pathTokens: string[] = [];
  let skipNext = false;

  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (isInlineProgramFlag(interpreter, token)) {
      skipNext = !token.includes('=');
      continue;
    }
    pathTokens.push(token);
  }

  return pathTokens;
}

function isInlineProgramFlag(interpreter: string, token: string): boolean {
  const flags = INLINE_PROGRAM_FLAGS.get(interpreter);
  if (flags === undefined) return false;
  return flags.has(flagName(token));
}

function flagName(token: string): string {
  const eq = token.indexOf('=');
  return eq === -1 ? token : token.slice(0, eq);
}

function firstNonOptionIndex(tokens: readonly string[], start: number): number | null {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token === '--') return null;
    if (token.startsWith('-') && token !== '-') continue;
    return i;
  }
  return null;
}

export function isPackageManager(name: string): boolean {
  return PACKAGE_MANAGERS.has(name);
}

function runsNamedScript(manager: string, command: string): boolean {
  if (manager !== 'npm') return command === 'run' || command === 'run-script';
  return NPM_RUN_ALIASES.has(command) || (command.length >= 4 && 'run-script'.startsWith(command));
}

// yarn, pnpm and bun run the script that a bare word names; npm does so only for its
// lifecycle commands.
export function packageManagerScriptName(tokens: readonly string[]): string | null {
  const name = withoutPackageSpec(tokens[0] ?? '');
  const manager = PACKAGE_MANAGER_ALIASES.get(name) ?? name;
  if (!isPackageManager(manager)) return null;

  const subcommandIndex = firstNonOptionIndex(tokens, 1);
  if (subcommandIndex === null) return null;

  const subcommand = tokens[subcommandIndex] ?? '';
  const command =
    manager === 'npm'
      ? subcommand.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      : subcommand;
  if (runsNamedScript(manager, command)) {
    const scriptIndex = firstNonOptionIndex(tokens, subcommandIndex + 1);
    return scriptIndex === null ? null : (tokens[scriptIndex] ?? null);
  }

  if (manager !== 'npm') return subcommand;
  return NPM_LIFECYCLE_ALIASES.get(command) ?? null;
}

// A wrapper or another package manager can run the manager: `timeout 5 npm run check`,
// `npx npm run check` and `pnpm exec npm run check` run `check` too.
export function packageManagerScriptNames(tokens: readonly string[]): readonly string[] {
  return tokens.flatMap((_, index) => packageManagerScriptName(tokens.slice(index)) ?? []);
}

export function isPackageManagerScriptInvocation(tokens: readonly string[]): boolean {
  return packageManagerScriptName(tokens) !== null;
}

// npm install and npm ci run the full lifecycle chain in the documented order; the same names
// are read for every project that installs (including through yarn/pnpm/bun), so an install
// target that changes always invalidates trust. `--ignore-scripts` is not special-cased: extra
// invalidation is accepted over an environment-sensitive exclusion.
const NPM_INSTALL_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
] as const;

// A package manager runs `pre<name>` and `post<name>` around the script it names. For `restart`,
// pnpm also runs `stop` and `start`, and npm does when the project has no `restart` script.
export function scriptsRunFor(scriptName: string): readonly string[] {
  if (scriptName === 'install') return NPM_INSTALL_SCRIPTS;
  const names = scriptName === 'restart' ? ['stop', 'restart', 'start'] : [scriptName];
  return names.flatMap((name) => [`pre${name}`, name, `post${name}`]);
}

type SafeForms = Readonly<{ bare: boolean; alone: readonly string[] }>;

const NO_SAFE_FORM: SafeForms = { bare: false, alone: [] };

/**
 * Programs whose behaviour a file in the working directory drives: a build or task file, a
 * package manifest and its scripts, a test tree, a launcher option file. `bare` marks a program
 * that only prints its usage when it gets no argument, and `alone` lists the only arguments that,
 * given on their own, return before the program reads such a file. Every other argv of these
 * programs is repo-local. A program with no safe form reads a project file even for its version:
 * yarn runs the `yarnPath` of `.yarnrc.yml`, Corepack runs the `packageManager` that
 * `.corepack.env` may point at any URL, pytest and tox import `conftest.py` and `toxfile.py`,
 * poetry loads project plugins, and the Maven, sbt and .NET launchers take JVM options or an SDK
 * path from the checkout. Composer, Gradle and pipenv are not known to stop before their project
 * files, so they stay closed too. Bare `npx` starts the `script-shell` that `.npmrc` names.
 */
const PROJECT_DRIVEN_PROGRAMS = new Map<string, SafeForms>([
  ['make', { bare: false, alone: ['--version', '-v', '--help', '-h'] }],
  ['gmake', { bare: false, alone: ['--version', '-v', '--help', '-h'] }],
  ['just', { bare: false, alone: ['--version', '-V', '--help', '-h'] }],
  ['task', { bare: false, alone: ['--version', '--help', '-h'] }],
  ['rake', { bare: false, alone: ['--version', '-V', '--help', '-h', '-H'] }],
  ['cargo', { bare: true, alone: ['--version', '-V', 'version', '--help', '-h', 'help'] }],
  ['go', { bare: true, alone: ['version', 'help', '--help', '-h'] }],
  ['pytest', NO_SAFE_FORM],
  ['py.test', NO_SAFE_FORM],
  ['tox', NO_SAFE_FORM],
  ['nox', { bare: false, alone: ['--version', '--help', '-h'] }],
  ['uv', { bare: true, alone: ['--version', '-V', '--help', '-h', 'help'] }],
  ['uvx', { bare: true, alone: ['--version', '-V', '--help', '-h'] }],
  ['poetry', NO_SAFE_FORM],
  ['pipenv', NO_SAFE_FORM],
  ['npm', { bare: true, alone: ['--version', '-v', '--help', '-h', 'help'] }],
  ['npx', { bare: false, alone: ['--version', '-v', '--help', '-h'] }],
  ['yarn', NO_SAFE_FORM],
  ['yarnpkg', NO_SAFE_FORM],
  ['pnpm', NO_SAFE_FORM],
  ['pnpx', NO_SAFE_FORM],
  ['bun', { bare: true, alone: ['--version', '-v', '--help', '-h'] }],
  ['bunx', { bare: true, alone: ['--version', '-v', '--help', '-h'] }],
  ['deno', { bare: false, alone: ['--version', '-V', '-v', '--help', '-h'] }],
  ['tsx', { bare: false, alone: ['--version', '-v', '--help', '-h'] }],
  ['ts-node', { bare: false, alone: ['--version', '-v', '--help', '-h'] }],
  ['mvn', NO_SAFE_FORM],
  ['mvnw', NO_SAFE_FORM],
  ['gradle', NO_SAFE_FORM],
  ['gradlew', NO_SAFE_FORM],
  ['sbt', NO_SAFE_FORM],
  ['dotnet', NO_SAFE_FORM],
  ['mix', { bare: false, alone: ['--version', '-v', '--help', '-h'] }],
  ['bundle', { bare: false, alone: ['--version', '-v', 'version', '--help', '-h', 'help'] }],
  ['composer', NO_SAFE_FORM],
]);

const RUST_TOOLCHAIN_FILES = ['rust-toolchain', 'rust-toolchain.toml'];
const BUNDLER_LOCK_FILES = [
  'Gemfile.lock',
  'gems.locked',
  'gems.rb.lock',
  'gem.deps.rb.lock',
  'Isolate.lock',
  '.bundle/config',
];

/**
 * Project files that choose which binary a program runs before any subcommand: rustup takes the
 * toolchain, or a `path` to one, from `rust-toolchain.toml` for itself and every proxy it
 * installs; the go command runs the `toolchain` or `go` version that `go.mod` or `go.work` names,
 * searching PATH first; RubyGems activates, and Bundler restarts as, the version that a lockfile
 * or `.bundle/config` locks. RubyGems names the lockfile after the dependency file it finds, so a
 * `gems.rb` project locks through `gems.rb.lock` as well as Bundler's `gems.locked`. Each tool
 * takes the first such file in its working directory or any parent, so a file above the project
 * selects the binary too. When one of these files exists, every form of the program is
 * repo-local, its version and help forms included.
 */
const TOOLCHAIN_FILES = new Map<string, readonly string[]>([
  ['rustup', RUST_TOOLCHAIN_FILES],
  ['cargo', RUST_TOOLCHAIN_FILES],
  ['cargo-clippy', RUST_TOOLCHAIN_FILES],
  ['cargo-fmt', RUST_TOOLCHAIN_FILES],
  ['cargo-miri', RUST_TOOLCHAIN_FILES],
  ['clippy-driver', RUST_TOOLCHAIN_FILES],
  ['rls', RUST_TOOLCHAIN_FILES],
  ['rust-analyzer', RUST_TOOLCHAIN_FILES],
  ['rust-gdb', RUST_TOOLCHAIN_FILES],
  ['rust-gdbgui', RUST_TOOLCHAIN_FILES],
  ['rust-lldb', RUST_TOOLCHAIN_FILES],
  ['rustc', RUST_TOOLCHAIN_FILES],
  ['rustdoc', RUST_TOOLCHAIN_FILES],
  ['rustfmt', RUST_TOOLCHAIN_FILES],
  ['go', ['go.mod', 'go.work']],
  ['bundle', BUNDLER_LOCK_FILES],
]);

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function existsInProject(name: string, projectDir: string): boolean {
  return entryExists(resolve(projectDir, name));
}

export function isProjectFile(input: { name: string; projectDir: string }): boolean {
  const { name, projectDir } = input;
  try {
    return lstatSync(resolve(projectDir, name)).isFile();
  } catch {
    return false;
  }
}

// Node's entry point is resolved as if it had been requested by require() from the working
// directory (nodejs.org/api/cli.html#program-entry-point): the exact path, then require's
// extension list, then a directory's package.json `main` and its index files.
const NODE_ENTRY_EXTENSIONS = ['.js', '.json', '.node'] as const;
const NODE_INDEX_FILES = ['index.js', 'index.json', 'index.node'] as const;

export type NodeEntryResolution =
  | { kind: 'file'; path: string }
  | { kind: 'symlink'; path: string }
  | { kind: 'escaped' }
  | { kind: 'missing' };

type EntryCandidateProbe = 'file' | 'symlink' | 'directory' | 'missing' | 'escaped';

function probeEntryCandidate(root: string, candidate: string): EntryCandidateProbe {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(candidate);
  } catch {
    return 'missing';
  }
  if (stats.isDirectory()) return 'directory';
  if (!stats.isFile() && !stats.isSymbolicLink()) return 'missing';
  if (!isInsideRoot(root, candidate)) return 'escaped';
  return stats.isSymbolicLink() ? 'symlink' : 'file';
}

function resolveCandidate(
  root: string,
  candidate: string,
  probe: EntryCandidateProbe,
): NodeEntryResolution {
  if (probe === 'escaped') return { kind: 'escaped' };
  return {
    kind: probe === 'symlink' ? 'symlink' : 'file',
    path: relative(root, candidate),
  };
}

function firstResolvedCandidate(
  root: string,
  candidates: readonly string[],
): NodeEntryResolution | null {
  for (const candidate of candidates) {
    const probe = probeEntryCandidate(root, candidate);
    if (probe === 'file' || probe === 'symlink' || probe === 'escaped') {
      return resolveCandidate(root, candidate, probe);
    }
  }
  return null;
}

// require() loads a `main` that names a directory through that directory's own index files
// (LOAD_INDEX(M)) before falling back to the package directory's index (LOAD_INDEX(X)).
function packageMainEntry(root: string, dir: string): NodeEntryResolution | null {
  const pkg = readPackageJson(dir);
  const main = pkg === null ? null : pkg['main'];
  if (typeof main !== 'string' || main.trim() === '') return null;
  const base = resolve(dir, main);
  return firstResolvedCandidate(root, [
    base,
    ...NODE_ENTRY_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...NODE_INDEX_FILES.map((name) => join(base, name)),
  ]);
}

/**
 * Resolves the file `node <operand>` runs. The operand must be lexically inside the project; an
 * escaping spelling keeps the constant confinement refusal the digest already records. A
 * candidate that exists but is a symlink is reported, never followed, and a candidate outside
 * the project is reported as escaped, never hashed. Resolution reads only metadata and
 * package.json through the regular-file-gated reader; no repository code runs.
 */
export function resolveNodeEntryPath(input: {
  projectDir: string;
  operand: string;
}): NodeEntryResolution | null {
  const root = resolve(input.projectDir);
  const base = resolve(root, input.operand);
  if (!isInsideRoot(root, base)) return null;

  const exact = probeEntryCandidate(root, base);
  if (exact === 'file' || exact === 'symlink' || exact === 'escaped') {
    return resolveCandidate(root, base, exact);
  }
  const byExtension = firstResolvedCandidate(
    root,
    NODE_ENTRY_EXTENSIONS.map((extension) => `${base}${extension}`),
  );
  if (byExtension !== null) return byExtension;
  if (exact !== 'directory') return { kind: 'missing' };

  const packageJson = join(base, 'package.json');
  const packageProbe = probeEntryCandidate(root, packageJson);
  if (packageProbe === 'symlink') return resolveCandidate(root, packageJson, packageProbe);
  if (packageProbe === 'file') {
    const byMain = packageMainEntry(root, base);
    if (byMain !== null) return byMain;
  }
  const byIndex = firstResolvedCandidate(
    root,
    NODE_INDEX_FILES.map((name) => join(base, name)),
  );
  return byIndex ?? { kind: 'missing' };
}

function fileAtOrAbove(dir: string, files: readonly string[]): boolean {
  if (files.some((file) => entryExists(join(dir, file)))) return true;
  const parent = dirname(dir);
  return parent !== dir && fileAtOrAbove(parent, files);
}

function projectSelectsToolchain(program: string, projectDir: string): boolean {
  const files = TOOLCHAIN_FILES.get(program);
  if (files === undefined) return false;
  const starts = [resolve(projectDir), realpathOrResolve(projectDir)];
  return starts.some((dir) => fileAtOrAbove(dir, files));
}

export function isProjectDrivenProgram(command: string): boolean {
  const program = commandName(command);
  return PROJECT_DRIVEN_PROGRAMS.has(program) || TOOLCHAIN_FILES.has(program);
}

export function runsProjectDefinedCode(argv: readonly string[], projectDir: string): boolean {
  const [command, ...args] = argv;
  if (command === undefined) return false;
  const program = commandName(command);
  if (projectSelectsToolchain(program, projectDir)) return true;
  const forms = PROJECT_DRIVEN_PROGRAMS.get(program);
  if (forms === undefined) return false;
  if (args.length === 0) return !forms.bare;
  return args.length > 1 || !forms.alone.includes(args[0] ?? '');
}

export function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function isInsideProject(projectDir: string, target: string): boolean {
  if (isInsideRoot(resolve(projectDir), resolve(target))) return true;
  return isInsideRoot(realpathOrResolve(projectDir), realpathOrResolve(target));
}

export function isBareCommandResolvedInsideProject(
  command: string,
  projectDir: string,
  pathEnv = process.env['PATH'] ?? '',
): boolean {
  const resolved = resolveBareCommandOnPath(command, projectDir, pathEnv);
  return resolved !== null && isInsideProject(projectDir, resolved);
}
