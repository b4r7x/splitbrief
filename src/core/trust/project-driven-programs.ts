import { dirname, join, resolve } from 'node:path';
import { entryExists, realpathOrResolve, commandName } from './path-classification.js';

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
