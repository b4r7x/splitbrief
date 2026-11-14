import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text/diagnostic.js';
import { escapeRegExp } from '../../../utils/regexp.js';
import type { ToolUseGuard } from '../../runners/cli-tools/process-invoke/invoke.js';
import { type IsolationBoundary, isWithin, canonicalPath, zoneOf } from './boundary.js';
import { DEPENDENCY_MARKERS } from './checkout-audit.js';
import type { PathAccess, PathReference } from './shell/types.js';
import { type ToolUse, readToolUse, toolUseInputText } from './tool-paths.js';

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

/**
 * A read in the tool's own state or in an agent skills folder as the tool
 * named it, before its links resolve: agy links `~/.gemini/skills` into
 * `~/.agents/skills`, a skills folder links its skills from anywhere, and
 * loading skills is the tool's own business wherever they lead.
 */
function readsToolStateOrSkills(boundary: IsolationBoundary, reference: PathReference): boolean {
  if (reference.access === 'write') return false;
  const path = resolve(reference.path);
  return boundary.readDirs.some((dir) => isWithin(dir, path));
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
  if (readsToolStateOrSkills(boundary, reference) || touchesDependency(boundary, reference)) {
    return null;
  }
  const path = canonicalPath(reference.path, { followsLink: reference.followsLink });
  if (zoneOf(boundary, path)?.allows.has(reference.access) !== true) return path;
  if (reference.access !== 'search') return null;
  const closed = boundary.zones.some(
    (zone) => !zone.allows.has('search') && zone.root !== path && isWithin(path, zone.root),
  );
  return closed ? path : null;
}

const EXCERPT_MAX_CHARS = 200;

function excerptOf(line: string): string {
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

/**
 * A path beside the isolation directory, spelled from it and compared canonical
 * against canonical; any other path as the tool named it, its home spelled `~`.
 */
function spellPath(boundary: IsolationBoundary, named: string, canonical: string): string {
  return boundary.siblingsDir !== null && isWithin(boundary.siblingsDir, canonical)
    ? relative(boundary.isolationDir, canonical)
    : tildeHomes(boundary, named);
}

type Inspection = Readonly<{ breaches: readonly IsolationBreach[]; cwd: string }>;

function inspect(boundary: IsolationBoundary, toolUse: ToolUse, cwd: string): Inspection {
  const scope = { cwd, home: boundary.home, tmpdir: boundary.tmpdir };
  const reading = readToolUse(toolUse, scope);
  const inputLine = tildeHomes(
    boundary,
    sanitizeTerminalDiagnosticText(toolUseInputText(toolUse)).replaceAll(/\s+/g, ' ').trim(),
  );
  const breaches: IsolationBreach[] = [];
  for (const reference of reading.references) {
    const canonical = crosses(boundary, reference);
    if (canonical === null) continue;
    // The note says when a link carried the path into the checkout.
    breaches.push({
      tool: toolUse.name,
      path: spellPath(boundary, reference.path, canonical),
      access: reference.access,
      where: breachWhere(boundary, canonical),
      changesPackages: reference.changesPackages === true,
      excerpt: inputLine === tildeHomes(boundary, reference.path) ? '' : excerptOf(inputLine),
    });
  }
  return { breaches, cwd: reading.cwd };
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
  return inspect(boundary, toolUse, cwd).breaches[0] ?? null;
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
  outside: ' (outside the workspace)',
};

/** The way through a package-manager halt, in the words of the implementer prompt's own rule. */
const PACKAGE_CHANGE_WAY_THROUGH =
  "a package-manager install, ci, add, remove or update writes to the project's shared node_modules; change the dependencies in the project yourself, then retry";

/**
 * `searched ~ (outside the workspace) with run_command: find ~ -name x` — the
 * evidence the halt carries, worded to follow the name of the tool that did it.
 */
export function formatIsolationBreach(breach: IsolationBreach): string {
  if (breach.changesPackages) {
    return `ran a package-manager command with ${breach.tool}: ${breach.excerpt} — ${PACKAGE_CHANGE_WAY_THROUGH}`;
  }
  const head = `${ACCESS_VERBS[breach.access]} ${breach.path}${WHERE_NOTES[breach.where]} with ${breach.tool}`;
  return breach.excerpt === '' ? head : `${head}: ${breach.excerpt}`;
}

/**
 * The guard that stops a CLI implementer call at its first write outside the
 * boundary; a read, list or search outside goes to `onOutsideRead` and the call
 * goes on. When the tool's shell keeps its working directory between tool
 * calls, the next command reads from where the last `cd` left it, while that
 * stays in one of `shellCwdRoots`; every other command reads from the isolation
 * directory.
 */
export function isolationToolUseGuard(
  boundary: IsolationBoundary,
  { onOutsideRead }: { onOutsideRead: (breach: IsolationBreach) => void },
): ToolUseGuard {
  let cwd = boundary.isolationDir;
  return (toolUse) => {
    const inspection = inspect(boundary, toolUse, cwd);
    const write = inspection.breaches.find((breach) => breach.access === 'write');
    if (write !== undefined) {
      return { code: 'implementer-left-isolation', message: formatIsolationBreach(write) };
    }
    for (const breach of inspection.breaches) onOutsideRead(breach);
    // Claude Code keeps `pwd -P` and resets its shell to the directory it started in
    // when that lies outside its working directories.
    const next = canonicalPath(inspection.cwd);
    cwd = boundary.shellCwdRoots.some((root) => isWithin(root, next))
      ? next
      : boundary.isolationDir;
    return null;
  };
}
