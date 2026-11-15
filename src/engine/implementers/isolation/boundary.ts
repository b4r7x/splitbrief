import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import {
  GLOBAL_SKILL_SCAN_PATHS,
  PROJECT_SKILL_SCAN_PATHS,
} from '../../../core/skills/scan-paths.js';
import { cliToolHome, hasCliToolHome } from '../../runners/host-model-selection.js';
import { isWithinRoot } from '../../../utils/path/within.js';
import { resolveFollowingLinks } from './shell/read.js';
import type { PathAccess } from './shell/types.js';

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
 * tool's own state, read-only system and toolchain roots, and the run's global
 * skills, read-only. The checkout the run promotes into is closed except for
 * reads of its `node_modules`, which the isolation directory links to, and of
 * its agent skills folders. Every other path is outside.
 */
export type IsolationBoundary = Readonly<{
  isolationDir: string;
  /**
   * The directory whose other entries — another worktree under the same parent — evidence spells
   * from the isolation directory; null when it holds a home, whose paths `~` spells shorter.
   */
  siblingsDir: string | null;
  checkoutDir: string;
  /** What `~` and `$HOME` expand to in the tool's shell. */
  home: string;
  /** The homes evidence spells as `~`, longest first: the tool's and the operator's. */
  displayHomes: readonly string[];
  /**
   * The tool's own state directories and every agent skills folder, home and project, as the
   * tool names them, before their links resolve.
   */
  readDirs: readonly string[];
  /**
   * Where a shell keeps the directory a `cd` left it in for the next tool call: Claude Code's
   * working directories, the isolation directory and the run's global skills. Empty for every
   * other tool.
   */
  shellCwdRoots: readonly string[];
  tmpdir: string | undefined;
  zones: readonly Zone[];
}>;

/** A path with every existing component resolved, so `/var` and `/private/var` compare equal. */
export function canonicalPath(
  path: string,
  { followsLink = true }: { followsLink?: boolean } = {},
): string {
  const absolute = resolveFollowingLinks(process.cwd(), path);
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

function isAncestorOfAny(path: string, targets: readonly string[]): boolean {
  return path === '/' || targets.some((target) => isWithinRoot(path, target));
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
    const nearHome =
      isAncestorOfAny(prefix, homes) || homes.some((home) => isWithinRoot(home, prefix));
    if (basename(root) === 'bin' && !nearHome) roots.push(prefix);
  }
  return roots;
}

export function createIsolationBoundary(input: {
  isolationDir: string;
  checkoutDir: string;
  env: Readonly<Record<string, string | undefined>>;
  tool?: CliToolId | undefined;
  /** The run's global skills: the prompt names their files, so the call may read them. */
  skillRoots?: readonly string[] | undefined;
}): IsolationBoundary {
  const isolationDir = canonicalPath(input.isolationDir);
  const checkoutDir = canonicalPath(input.checkoutDir);
  const home =
    input.env.HOME !== undefined && isAbsolute(input.env.HOME) ? input.env.HOME : homedir();
  const homes = [...new Set([canonicalPath(homedir()), canonicalPath(home)])];
  const toolStates = input.tool === undefined ? [] : TOOL_STATE_DIRS[input.tool];
  // A config folder the call env moves out of the home is the tool's state too.
  const toolHome =
    input.tool !== undefined && hasCliToolHome(input.tool)
      ? cliToolHome(input.tool, input.env, home)
      : undefined;
  const toolHomes = toolHome !== undefined && isAbsolute(toolHome) ? [toolHome] : [];
  const underHomes = (dirs: readonly string[]) =>
    homes.flatMap((root) => dirs.map((dir) => canonicalPath(join(root, dir))));
  const temp = [tmpdir(), input.env.TMPDIR, ...TEMP_ROOTS].filter(
    (dir): dir is string => dir !== undefined && isAbsolute(dir),
  );
  const nodePrefix = dirname(dirname(process.execPath));
  const skillRoots = (input.skillRoots ?? []).map((root) => canonicalPath(root));

  const zones: Zone[] = [
    { root: isolationDir, allows: ANY },
    // In the checkout mode the call works in the checkout itself, so it is not closed to it.
    ...(checkoutDir === isolationDir ? [] : [{ root: checkoutDir, allows: NONE }]),
    { root: canonicalPath(join(checkoutDir, 'node_modules')), allows: READS },
    ...temp.map((dir) => ({ root: canonicalPath(dir), allows: ANY })),
    ...DEVICES.map((device) => ({ root: device, allows: ANY })),
    ...underHomes(toolStates).map((root) => ({ root, allows: ANY })),
    ...toolHomes.map((root) => ({ root: canonicalPath(root), allows: ANY })),
    ...SYSTEM_ROOTS.map((root) => ({ root: canonicalPath(root), allows: READS })),
    ...underHomes(TOOLCHAIN_DIRS).map((root) => ({ root, allows: READS })),
    ...skillRoots.map((root) => ({ root, allows: READS })),
    ...pathEntryRoots(input.env.PATH, homes).map((root) => ({ root, allows: READS })),
    ...(isAncestorOfAny(nodePrefix, homes)
      ? []
      : [{ root: canonicalPath(nodePrefix), allows: READS }]),
  ];
  // The most specific root decides; between equal roots the stricter one does.
  zones.sort((a, b) => b.root.length - a.root.length || a.allows.size - b.allows.size);
  const displayHomes = [...new Set([home, homedir()])].sort((a, b) => b.length - a.length);
  const readDirs = [
    ...displayHomes.flatMap((root) =>
      [...toolStates, ...GLOBAL_SKILL_SCAN_PATHS].map((dir) => join(root, dir)),
    ),
    ...toolHomes,
    ...PROJECT_SKILL_SCAN_PATHS.map((dir) => join(checkoutDir, dir)),
  ];
  const parent = dirname(isolationDir);
  return {
    isolationDir,
    siblingsDir: isAncestorOfAny(parent, homes) ? null : parent,
    checkoutDir,
    home,
    displayHomes,
    readDirs,
    shellCwdRoots: input.tool === 'claude-code' ? [isolationDir, ...skillRoots] : [],
    tmpdir: input.env.TMPDIR,
    zones,
  };
}

export function zoneOf(boundary: IsolationBoundary, path: string): Zone | undefined {
  return boundary.zones.find((zone) => isWithinRoot(zone.root, path));
}
