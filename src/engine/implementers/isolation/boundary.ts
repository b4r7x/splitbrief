import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text.js';
import { escapeRegExp } from '../../../utils/regexp.js';
import type { ToolUseGuard } from '../../runners/cli-tools/process-invoke.js';
import { DEPENDENCY_MARKERS } from './checkout-audit.js';
import type { PathAccess, PathReference } from './shell-paths.js';
import { readToolUse, toolUseInputText, type ToolUse } from './tool-paths.js';

const ANY = new Set<PathAccess>(['read', 'list', 'search', 'write']);
const READS = new Set<PathAccess>(['read', 'list', 'search']);
const NONE = new Set<PathAccess>();

/** Read-only roots of the OS and its package managers; toolchains resolve and read here. */
const SYSTEM_ROOTS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/opt',
  '/etc',
  '/private/etc',
  '/Library',
  '/System/Library',
  '/System/Applications',
  '/Applications',
  '/nix',
  '/snap',
  '/proc',
  '/sys',
  '/dev',
  '/home/linuxbrew/.linuxbrew',
];
const TEMP_ROOTS = ['/tmp', '/var/tmp', '/var/folders'];
const DEVICES = ['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/fd'];
/**
 * Version managers, language toolchains and the skill library several tools
 * share under a home directory: read, never written.
 */
const TOOLCHAIN_DIRS = [
  '.agents',
  '.nvm',
  '.volta',
  '.fnm',
  '.local/share/fnm',
  '.asdf',
  '.local/share/mise',
  '.cargo',
  '.rustup',
  '.pyenv',
  '.rbenv',
  '.bun',
  '.deno',
  'go',
  '.sdkman',
  '.local/bin',
  'Library/pnpm',
  '.local/share/pnpm',
];

/**
 * Where each tool keeps its own state under the home it runs with. The tool
 * reads and writes there by design — agy runs its shell in
 * `~/.gemini/antigravity-cli/scratch` and files its plans under its brain
 * directory — so a tool use there is the tool's own business.
 */
const TOOL_STATE_DIRS: Readonly<Record<CliToolId, readonly string[]>> = {
  'claude-code': ['.claude', '.claude.json'],
  codex: ['.codex'],
  opencode: [
    '.config/opencode',
    '.local/share/opencode',
    '.local/state/opencode',
    '.cache/opencode',
  ],
  copilot: ['.copilot', '.config/github-copilot'],
  'kilo-code': [
    '.config/kilo',
    '.config/kilocode',
    '.kilocode',
    '.local/share/kilo',
    '.cache/kilo',
  ],
  cursor: ['.cursor'],
  'command-code': ['.commandcode'],
  antigravity: ['.gemini'],
};

type Zone = Readonly<{ root: string; allows: ReadonlySet<PathAccess> }>;

/**
 * Where an implementer call may reach, derived from its isolation directory:
 * the directory itself, the temp and device paths every toolchain writes, the
 * tool's own state, and read-only system and toolchain roots. The checkout the
 * run promotes into is closed except for reads of its `node_modules`, which the
 * isolation directory links to. Every other path is outside.
 */
export type IsolationBoundary = Readonly<{
  isolationDir: string;
  checkoutDir: string;
  /** What `~` and `$HOME` expand to in the tool's shell. */
  home: string;
  /** The homes evidence spells as `~`, longest first: the tool's and the operator's. */
  displayHomes: readonly string[];
  /** The tool's own state directories as the tool names them, before their links resolve. */
  toolStateDirs: readonly string[];
  /** Claude Code's shell keeps the directory a `cd` left it in for the next tool call. */
  keepsShellCwd: boolean;
  tmpdir: string | undefined;
  zones: readonly Zone[];
}>;

export type IsolationBreach = Readonly<{
  tool: string;
  path: string;
  access: PathAccess;
  /** The closed place the path lies in: the checkout the run promotes into, its dependencies, or neither. */
  where: 'checkout' | 'dependencies' | 'outside';
  /** A package-manager install, ci, add, remove or update, which the halt copy names a way through for. */
  changesPackages: boolean;
  excerpt: string;
}>;

/** A path with every existing component resolved, so `/var` and `/private/var` compare equal. */
function canonicalPath(
  path: string,
  { followsLink = true }: { followsLink?: boolean } = {},
): string {
  const absolute = resolve(path);
  if (!followsLink) {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
  const missing: string[] = [];
  let existing = absolute;
  while (true) {
    try {
      return join(realpathSync(existing), ...missing.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

/** `root` itself or anything under it; `<root>/...` is a name under it, not its parent. */
function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isAncestorOfAny(path: string, targets: readonly string[]): boolean {
  return path === '/' || targets.some((target) => isWithin(path, target));
}

/**
 * `PATH` entries, never a home or anything above one, and the prefix a `bin`
 * entry outside the homes belongs to. Under a home the prefix would be a
 * directory like `~/.local`, whose other contents are not a toolchain; the
 * toolchains kept there are listed by name.
 */
function pathEntryRoots(pathValue: string | undefined, homes: readonly string[]): string[] {
  const roots: string[] = [];
  for (const entry of (pathValue ?? '').split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    const root = canonicalPath(entry);
    if (isAncestorOfAny(root, homes)) continue;
    roots.push(root);
    const prefix = dirname(root);
    const nearHome = isAncestorOfAny(prefix, homes) || homes.some((home) => isWithin(home, prefix));
    if (basename(root) === 'bin' && !nearHome) roots.push(prefix);
  }
  return roots;
}

export function createIsolationBoundary(input: {
  isolationDir: string;
  checkoutDir: string;
  env: Readonly<Record<string, string | undefined>>;
  tool?: CliToolId | undefined;
}): IsolationBoundary {
  const isolationDir = canonicalPath(input.isolationDir);
  const checkoutDir = canonicalPath(input.checkoutDir);
  const home =
    input.env.HOME !== undefined && isAbsolute(input.env.HOME) ? input.env.HOME : homedir();
  const homes = [...new Set([canonicalPath(homedir()), canonicalPath(home)])];
  const toolStates = input.tool === undefined ? [] : TOOL_STATE_DIRS[input.tool];
  const underHomes = (dirs: readonly string[]) =>
    homes.flatMap((root) => dirs.map((dir) => canonicalPath(join(root, dir))));
  const temp = [tmpdir(), input.env.TMPDIR, ...TEMP_ROOTS].filter(
    (dir): dir is string => dir !== undefined && isAbsolute(dir),
  );
  const nodePrefix = dirname(dirname(process.execPath));

  const zones: Zone[] = [
    { root: isolationDir, allows: ANY },
    { root: checkoutDir, allows: NONE },
    { root: canonicalPath(join(checkoutDir, 'node_modules')), allows: READS },
    ...temp.map((dir) => ({ root: canonicalPath(dir), allows: ANY })),
    ...DEVICES.map((device) => ({ root: device, allows: ANY })),
    ...underHomes(toolStates).map((root) => ({ root, allows: ANY })),
    ...SYSTEM_ROOTS.map((root) => ({ root: canonicalPath(root), allows: READS })),
    ...underHomes(TOOLCHAIN_DIRS).map((root) => ({ root, allows: READS })),
    ...pathEntryRoots(input.env.PATH, homes).map((root) => ({ root, allows: READS })),
    ...(isAncestorOfAny(nodePrefix, homes)
      ? []
      : [{ root: canonicalPath(nodePrefix), allows: READS }]),
  ];
  // The most specific root decides; between equal roots the stricter one does.
  zones.sort((a, b) => b.root.length - a.root.length || a.allows.size - b.allows.size);
  const displayHomes = [...new Set([home, homedir()])].sort((a, b) => b.length - a.length);
  const toolStateDirs = displayHomes.flatMap((root) => toolStates.map((dir) => join(root, dir)));
  return {
    isolationDir,
    checkoutDir,
    home,
    displayHomes,
    toolStateDirs,
    keepsShellCwd: input.tool === 'claude-code',
    tmpdir: input.env.TMPDIR,
    zones,
  };
}

function zoneOf(boundary: IsolationBoundary, path: string): Zone | undefined {
  return boundary.zones.find((zone) => isWithin(zone.root, path));
}

/**
 * A read in the tool's own state as the tool named it, before its links
 * resolve: agy links `~/.gemini/skills` into `~/.agents/skills`, and loading
 * its skills is the tool's own business wherever they lead.
 */
function readsToolState(boundary: IsolationBoundary, reference: PathReference): boolean {
  if (reference.access === 'write') return false;
  const path = resolve(reference.path);
  return boundary.toolStateDirs.some((dir) => isWithin(dir, path));
}

/** The dot entries of `node_modules` that hold what is installed, not a tool cache. */
const INSTALLED_DOT_ENTRIES = ['.bin', '.pnpm', ...DEPENDENCY_MARKERS];

/**
 * A use of `node_modules` as the tool named it, before its links resolve, that
 * leaves the installed packages as they are. A read may go anywhere: a
 * workspace package links on into the checkout's own sources (`@acme/core` →
 * `packages/core`), and reading its built files is what installing it is for.
 * A write may change a tool cache (`.vite`, `.cache`) at any depth, which the
 * checkout audit ignores too — never `.bin`, pnpm's `.pnpm` store or a package
 * manager's lockfile.
 */
function touchesDependency(boundary: IsolationBoundary, reference: PathReference): boolean {
  const segments = resolve(reference.path).split(sep);
  const at = segments.indexOf('node_modules');
  if (at === -1) return false;
  const owner = canonicalPath(segments.slice(0, at).join(sep) || sep);
  if (owner !== boundary.isolationDir && owner !== boundary.checkoutDir) return false;
  if (reference.access !== 'write') return true;
  const name = segments[at + 1];
  return name?.startsWith('.') === true && !INSTALLED_DOT_ENTRIES.includes(name);
}

/**
 * The canonical path a reference reaches outside the boundary, or null when it
 * stays inside. A search walks everything under its root, so a root that holds
 * a place it may not search — a checkout that lives under a temp directory — is
 * a search of that place too.
 */
function crosses(boundary: IsolationBoundary, reference: PathReference): string | null {
  // A word only guessed to be a path reaches something only if it exists: a test name like
  // `/api/users` or a container path like `/app` is not a place on this disk.
  if (reference.mentioned === true && !existsSync(reference.path)) return null;
  if (readsToolState(boundary, reference) || touchesDependency(boundary, reference)) return null;
  const path = canonicalPath(reference.path, { followsLink: reference.followsLink });
  if (zoneOf(boundary, path)?.allows.has(reference.access) !== true) return path;
  if (reference.access !== 'search') return null;
  const closed = boundary.zones.some(
    (zone) => !zone.allows.has('search') && zone.root !== path && isWithin(path, zone.root),
  );
  return closed ? path : null;
}

const EXCERPT_MAX_CHARS = 200;

function excerptOf(toolUse: ToolUse): string {
  const line = sanitizeTerminalDiagnosticText(toolUseInputText(toolUse))
    .replaceAll(/\s+/g, ' ')
    .trim();
  return line.length > EXCERPT_MAX_CHARS ? `${line.slice(0, EXCERPT_MAX_CHARS - 1)}…` : line;
}

function breachWhere(boundary: IsolationBoundary, path: string): IsolationBreach['where'] {
  if (isWithin(join(boundary.checkoutDir, 'node_modules'), path)) return 'dependencies';
  return isWithin(boundary.checkoutDir, path) ? 'checkout' : 'outside';
}

/**
 * A home directory spelled `~`, as the operator reads it; the evidence then
 * names no account and stays short.
 */
function tildeHomes(boundary: IsolationBoundary, text: string): string {
  return boundary.displayHomes.reduce(
    (spelled, home) =>
      spelled.replace(new RegExp(`${escapeRegExp(home)}(?=$|[/\\s'"\`:;,)])`, 'g'), '~'),
    text,
  );
}

type Inspection = Readonly<{ breach: IsolationBreach | null; cwd: string }>;

function inspect(boundary: IsolationBoundary, toolUse: ToolUse, cwd: string): Inspection {
  const scope = { cwd, home: boundary.home, tmpdir: boundary.tmpdir };
  const reading = readToolUse(toolUse, scope);
  for (const reference of reading.references) {
    const canonical = crosses(boundary, reference);
    if (canonical === null) continue;
    // Reported as the tool named it; the note says when a link carried it into the checkout.
    const breach: IsolationBreach = {
      tool: toolUse.name,
      path: tildeHomes(boundary, reference.path),
      access: reference.access,
      where: breachWhere(boundary, canonical),
      changesPackages: reference.changesPackages === true,
      excerpt: tildeHomes(boundary, excerptOf(toolUse)),
    };
    return { breach, cwd: reading.cwd };
  }
  return { breach: null, cwd: reading.cwd };
}

/**
 * The first path this tool use reaches outside its isolation boundary, if any,
 * read from `cwd` — the isolation directory unless an earlier `cd` moved on.
 */
export function findIsolationBreach(
  boundary: IsolationBoundary,
  toolUse: ToolUse,
  cwd: string = boundary.isolationDir,
): IsolationBreach | null {
  return inspect(boundary, toolUse, cwd).breach;
}

const ACCESS_VERBS: Readonly<Record<PathAccess, string>> = {
  read: 'read',
  list: 'listed',
  search: 'searched',
  write: 'wrote to',
};

const WHERE_NOTES: Readonly<Record<IsolationBreach['where'], string>> = {
  checkout: ' (your checkout)',
  dependencies: " (your checkout's node_modules)",
  outside: '',
};

/** The way through a package-manager halt, in the words of the implementer prompt's own rule. */
const PACKAGE_CHANGE_WAY_THROUGH =
  "a package-manager install, ci, add, remove or update writes to the project's shared node_modules; change the dependencies in the project yourself, then retry";

/**
 * `searched ~ with run_command: find ~ -name x` — the evidence the halt carries,
 * worded to follow the name of the tool that did it.
 */
export function formatIsolationBreach(breach: IsolationBreach): string {
  if (breach.changesPackages) {
    return `ran a package-manager command with ${breach.tool}: ${breach.excerpt} — ${PACKAGE_CHANGE_WAY_THROUGH}`;
  }
  const head = `${ACCESS_VERBS[breach.access]} ${breach.path}${WHERE_NOTES[breach.where]} with ${breach.tool}`;
  return breach.excerpt === '' || breach.excerpt === breach.path
    ? head
    : `${head}: ${breach.excerpt}`;
}

/**
 * The guard that stops a CLI implementer call at its first tool use outside the
 * boundary. When the tool's shell keeps its working directory between tool
 * calls, the next command reads from where the last `cd` left it; every other
 * tool's command reads from the isolation directory.
 */
export function isolationToolUseGuard(boundary: IsolationBoundary): ToolUseGuard {
  let cwd = boundary.isolationDir;
  return (toolUse) => {
    const inspection = inspect(boundary, toolUse, cwd);
    const { breach } = inspection;
    if (boundary.keepsShellCwd && breach === null) cwd = inspection.cwd;
    return breach === null
      ? null
      : { code: 'implementer-left-isolation', message: formatIsolationBreach(breach) };
  };
}
