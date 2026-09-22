import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { isInsideRoot } from '../../lib/path-confinement.js';
import { parseShellCommand } from '../../utils/parse-shell-command.js';

const CODE_LOADING_INTERPRETERS = new Set([
  'node',
  'nodejs',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
  'npx',
  'tsx',
  'ts-node',
  'bun',
  'deno',
]);

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_SCRIPT_ALIASES = new Set(['start', 'stop', 'restart', 'test']);
const PROMPT_PLACEHOLDER = '{prompt}';
const SHELL_EVALUATORS = new Set(['sh', 'bash']);
const INLINE_PROGRAM_FLAGS = new Map<string, ReadonlySet<string>>([
  ['node', new Set(['-e', '--eval', '-p', '--print'])],
  ['nodejs', new Set(['-e', '--eval', '-p', '--print'])],
  ['python', new Set(['-c'])],
  ['python3', new Set(['-c'])],
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
  const name = commandName(interpreter);
  if (!CODE_LOADING_INTERPRETERS.has(name) || tokens.length <= 1) return tokens;
  return interpreterPathTokens(name, tokens.slice(1));
}

export function commandName(command: string): string {
  const executable = parseShellCommand(command)[0] ?? command;
  const name = executable.split(/[\\/]/).pop() ?? executable;
  return name.replace(/\.(cmd|exe|bat|ps1)$/i, '');
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

function hasScriptNameAfterRun(tokens: readonly string[], runIndex: number): boolean {
  return firstNonOptionIndex(tokens, runIndex + 1) !== null;
}

export function isPackageManagerScriptInvocation(tokens: readonly string[]): boolean {
  if (tokens.length < 2) return false;
  const manager = commandName(tokens[0] ?? '');
  if (!PACKAGE_MANAGERS.has(manager)) return false;

  const subcommandIndex = firstNonOptionIndex(tokens, 1);
  if (subcommandIndex === null) return false;

  const subcommand = tokens[subcommandIndex] ?? '';
  if (subcommand === 'run' || subcommand === 'run-script') {
    return hasScriptNameAfterRun(tokens, subcommandIndex);
  }

  return PACKAGE_SCRIPT_ALIASES.has(subcommand);
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

function programName(command: string): string {
  return commandName(command).toLowerCase();
}

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
  const program = programName(command);
  return PROJECT_DRIVEN_PROGRAMS.has(program) || TOOLCHAIN_FILES.has(program);
}

export function runsProjectDefinedCode(argv: readonly string[], projectDir: string): boolean {
  const [command, ...args] = argv;
  if (command === undefined) return false;
  const program = programName(command);
  if (projectSelectsToolchain(program, projectDir)) return true;
  const forms = PROJECT_DRIVEN_PROGRAMS.get(program);
  if (forms === undefined) return false;
  if (args.length === 0) return !forms.bare;
  return args.length > 1 || !forms.alone.includes(args[0] ?? '');
}

function executableExtensions(command: string): string[] {
  if (process.platform !== 'win32' || extname(command) !== '') return [''];
  const pathext = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
  return pathext
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveBareCommandOnPath(
  command: string,
  cwd: string,
  pathEnv = process.env['PATH'] ?? '',
): string | null {
  if (command.length === 0 || isPathLike(command)) return null;

  for (const entry of pathEnv.split(delimiter)) {
    const dir = entry.length > 0 ? entry : cwd;
    for (const ext of executableExtensions(command)) {
      const candidate = resolve(dir, `${command}${ext}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  return null;
}

function realpathOrResolve(path: string): string {
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

export function isShellEvaluatedPromptArg(
  command: string,
  args: readonly string[],
  placeholder = PROMPT_PLACEHOLDER,
): boolean {
  const name = commandName(command);
  if (!SHELL_EVALUATORS.has(name)) return false;
  return shellArgsEvaluateCommandString(args) && args.some((arg) => arg.includes(placeholder));
}

export function shellArgsEvaluateCommandString(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg === '-c') return true;
    if (isCombinedShellCommandFlag(arg)) return true;
    if (!arg.startsWith('-') || arg === '-') return false;
  }
  return false;
}

function isCombinedShellCommandFlag(arg: string): boolean {
  return (
    arg.startsWith('-') && !arg.startsWith('--') && arg.length > 2 && arg.slice(1).includes('c')
  );
}
