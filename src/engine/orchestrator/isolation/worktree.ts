import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { ensureConfigGitignore } from '../../../core/config/load/io.js';
import { isolationMarkerPath, SPLITBRIEF_DIR } from '../../../core/paths.js';
import type { GitClient } from '../../../lib/git/client.js';
import { checkIgnoredPaths, getCurrentChangedFiles } from '../../../lib/git/files.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import { error } from '../../../utils/error.js';
import { createWorktree } from '../../worktree/create.js';
import { assertTreesDirReadable, resolveConfinedWorktreePath } from '../../worktree/path.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { writeCurrentFileContent } from '../approval/file-snapshots/contents.js';

const MAX_SLUG_LENGTH = 64;

export type EnsureIsolationWorktreeResult =
  | { kind: 'ready'; worktreePath: string; reused: boolean }
  | { kind: 'fallback'; reason: string };

const isolationError = {
  seedSymlink: (file: string) =>
    error('isolation-seed-symlink', `Cannot seed isolation worktree: "${file}" is a symlink.`, {
      file,
    }),
} as const;

async function readIsolationMarker(wtPath: string): Promise<string | null> {
  try {
    return await readFile(isolationMarkerPath(wtPath), 'utf-8');
  } catch {
    return null;
  }
}

async function writeIsolationMarker(wtPath: string, sessionId: string): Promise<void> {
  await mkdir(join(wtPath, SPLITBRIEF_DIR), { recursive: true });
  await writeFile(isolationMarkerPath(wtPath), sessionId, 'utf-8');
}

function roundTripsUtf8(raw: Buffer): boolean {
  return Buffer.from(raw.toString('utf8'), 'utf8').equals(raw);
}

async function isSymlinkAt(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

type SeedResult = { kind: 'ok' } | { kind: 'fallback'; reason: string };

const NODE_MODULES = 'node_modules';
const ROOT_NODE_MODULES = `/${NODE_MODULES}`;
const EXCLUDE_MARKER_PREFIX = '# splitbrief run isolation ';

async function linkProjectNodeModules(projectDir: string, wtPath: string): Promise<void> {
  const source = join(projectDir, NODE_MODULES);
  const target = join(wtPath, NODE_MODULES);
  if (!existsSync(source) || existsSync(target)) return;
  try {
    await symlink(source, target, 'dir');
  } catch {
    return;
  }
}

async function untrackedNodeModulesIn(wtPath: string): Promise<boolean> {
  const changed = await getCurrentChangedFiles(wtPath);
  return changed.some((file) => file === NODE_MODULES || file.startsWith(`${NODE_MODULES}/`));
}

async function repositoryExcludeFile(wtPath: string, git: GitClient): Promise<string> {
  const commonDir = (await git.raw(['-C', wtPath, 'rev-parse', '--git-common-dir'])).trim();
  return join(isAbsolute(commonDir) ? commonDir : join(wtPath, commonDir), 'info', 'exclude');
}

function excludeMarker(sessionId: string): string {
  return `${EXCLUDE_MARKER_PREFIX}${sessionId}`;
}

function ownsExcludeLine(lines: readonly string[], index: number): boolean {
  return (lines[index - 1] ?? '').startsWith(EXCLUDE_MARKER_PREFIX);
}

function hasUnownedNodeModulesExclude(text: string): boolean {
  const lines = text.split('\n');
  return lines.some(
    (line, index) => line.trim() === ROOT_NODE_MODULES && !ownsExcludeLine(lines, index),
  );
}

// git resolves info/exclude against the repository's common directory, so a
// linked worktree has no exclude file of its own and the shared one — the source
// checkout's — is the only place a pattern covering the link can go. It is
// written under a marker naming the session that wrote it and removed when that
// run disposes, so the checkout is left exactly as it was found and a concurrent
// run's block is never mistaken for this one's. The rooted form applies to each
// working tree's own root, and it is written only when the project already
// ignores the node_modules it names, so while it stands it cannot change what
// the source checkout reports; a repository that tracks or reports node_modules
// keeps doing so and the run falls back instead.
async function excludeNodeModulesLink(
  projectDir: string,
  wtPath: string,
  sessionId: string,
  git: GitClient,
): Promise<string | null> {
  if ((await checkIgnoredPaths(projectDir, [NODE_MODULES])).length === 0) return null;
  try {
    const file = await repositoryExcludeFile(wtPath, git);
    const marker = excludeMarker(sessionId);
    const current = existsSync(file) ? await readFile(file, 'utf-8') : '';
    if (current.split('\n').includes(marker)) return file;
    if (hasUnownedNodeModulesExclude(current)) return null;
    await mkdir(dirname(file), { recursive: true });
    const separator = current === '' || current.endsWith('\n') ? '' : '\n';
    await appendFile(file, `${separator}${marker}\n${ROOT_NODE_MODULES}\n`, 'utf-8');
    return file;
  } catch {
    return null;
  }
}

/** Drops the block `excludeNodeModulesLink` wrote for this session, and only that block. */
export async function removeNodeModulesExclude(file: string, sessionId: string): Promise<void> {
  const marker = excludeMarker(sessionId);
  try {
    const lines = (await readFile(file, 'utf-8')).split('\n');
    const kept = lines.filter(
      (line, index) =>
        line !== marker && !(lines[index - 1] === marker && line.trim() === ROOT_NODE_MODULES),
    );
    if (kept.length !== lines.length) await writeFile(file, kept.join('\n'), 'utf-8');
  } catch {
    return;
  }
}

async function seedIsolationWorktree(sourceDir: string, wtPath: string): Promise<SeedResult> {
  const snapshot = await getChangedFilesSnapshot(sourceDir);
  for (const [file, content] of Object.entries(snapshot.dirtyFileContents)) {
    assertPathConfined(file, sourceDir);
    if (await isSymlinkAt(join(sourceDir, file))) {
      throw isolationError.seedSymlink(file);
    }
    if (content === null) {
      await writeCurrentFileContent(wtPath, file, null);
      continue;
    }
    const raw = await readFile(join(sourceDir, file));
    if (!roundTripsUtf8(raw)) {
      return {
        kind: 'fallback',
        reason: `source file "${file}" cannot be seeded byte-identically (binary content)`,
      };
    }
    await writeCurrentFileContent(wtPath, file, raw.toString('utf8'));
  }
  return { kind: 'ok' };
}

export async function ensureIsolationWorktree(opts: {
  projectDir: string;
  sessionId: string;
  git: GitClient;
  onWorktreeCreated?: (worktreePath: string) => void;
  onNodeModulesExcluded?: (excludeFile: string) => void;
}): Promise<EnsureIsolationWorktreeResult> {
  const { projectDir, sessionId, git, onWorktreeCreated, onNodeModulesExcluded } = opts;
  assertTreesDirReadable(projectDir);
  const slug = sessionId.slice(0, MAX_SLUG_LENGTH);
  const wtPath = resolveConfinedWorktreePath(projectDir, slug);

  let reused: boolean;
  if (existsSync(wtPath)) {
    if ((await readIsolationMarker(wtPath)) !== sessionId) {
      return {
        kind: 'fallback',
        reason: `directory .trees/${slug} already exists and is not owned by session ${sessionId}`,
      };
    }
    reused = true;
  } else {
    await createWorktree({ projectDir, slug, git, requireCleanSource: false });
    onWorktreeCreated?.(wtPath);
    await writeIsolationMarker(wtPath, sessionId);
    const seeded = await seedIsolationWorktree(projectDir, wtPath);
    if (seeded.kind === 'fallback') return seeded;
    await ensureConfigGitignore(wtPath);
    reused = false;
  }

  await linkProjectNodeModules(projectDir, wtPath);
  if (await untrackedNodeModulesIn(wtPath)) {
    const excludeFile = await excludeNodeModulesLink(projectDir, wtPath, sessionId, git);
    if (excludeFile !== null) onNodeModulesExcluded?.(excludeFile);
    if (await untrackedNodeModulesIn(wtPath)) {
      return {
        kind: 'fallback',
        reason: `the repository does not ignore ${NODE_MODULES}; the dependency symlink would appear in every task's changed set`,
      };
    }
  }
  return { kind: 'ready', worktreePath: wtPath, reused };
}
