import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withFileLock, lockSibling } from '../../../../lib/fs/lock.js';
import { getCurrentChangedFiles, checkIgnoredPaths } from '../../../../lib/git/files.js';
import { isolationError } from '../errors.js';

function withExcludeFileLock<T>(file: string, fn: () => T): T {
  return withFileLock(file, () => isolationError.excludeLockTimeout(lockSibling(file)), fn);
}

export const NODE_MODULES = 'node_modules';
const ROOT_NODE_MODULES = `/${NODE_MODULES}`;
const EXCLUDE_MARKER_PREFIX = '# splitbrief run isolation ';

export async function linkProjectNodeModules(projectDir: string, wtPath: string): Promise<void> {
  const source = join(projectDir, NODE_MODULES);
  const target = join(wtPath, NODE_MODULES);
  if (!existsSync(source) || existsSync(target)) return;
  await symlink(source, target, 'dir');
}

export async function untrackedNodeModulesIn(wtPath: string): Promise<boolean> {
  const changed = await getCurrentChangedFiles(wtPath);
  return changed.some((file) => file === NODE_MODULES || file.startsWith(`${NODE_MODULES}/`));
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
export async function excludeNodeModulesLink(
  projectDir: string,
  gitCommonDir: string,
  sessionId: string,
  untracked: boolean,
): Promise<string | null> {
  if ((await checkIgnoredPaths(projectDir, [NODE_MODULES])).length === 0) return null;
  try {
    const file = join(gitCommonDir, 'info', 'exclude');
    const marker = excludeMarker(sessionId);
    return withExcludeFileLock(file, () => {
      const current = existsSync(file) ? readFileSync(file, 'utf-8') : '';
      if (current.split('\n').includes(marker)) return file;
      if (hasUnownedNodeModulesExclude(current)) return null;
      if (!untracked && !current.split('\n').some((line) => line.startsWith(EXCLUDE_MARKER_PREFIX)))
        return null;
      mkdirSync(dirname(file), { recursive: true });
      const separator = current === '' || current.endsWith('\n') ? '' : '\n';
      appendFileSync(file, `${separator}${marker}\n${ROOT_NODE_MODULES}\n`, 'utf-8');
      return file;
    });
  } catch {
    return null;
  }
}

/** Drops the block `excludeNodeModulesLink` wrote for this session, and only that block. */
export async function removeNodeModulesExclude(file: string, sessionId: string): Promise<void> {
  const marker = excludeMarker(sessionId);
  try {
    withExcludeFileLock(file, () => {
      const lines = readFileSync(file, 'utf-8').split('\n');
      const kept = lines.filter(
        (line, index) =>
          line !== marker && !(lines[index - 1] === marker && line.trim() === ROOT_NODE_MODULES),
      );
      if (kept.length !== lines.length) writeFileSync(file, kept.join('\n'), 'utf-8');
    });
  } catch {
    return;
  }
}
