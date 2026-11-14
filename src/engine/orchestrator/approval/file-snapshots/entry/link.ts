import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { CONTROL_PLANE_SEGMENTS } from '../../../../../core/scope/control-plane.js';
import { isENOENT } from '../../../../../utils/errno.js';
import { lstatConfinedEntry } from './read.js';

// Where the kernel lands `path` once its missing directories exist: name by
// name, through every link on the way, dangling or not. Null past the kernel's
// link limit: a dangling link that climbs back through itself never lands.
async function kernelLanding(path: string, links = { left: 40 }): Promise<string | null> {
  let landing = parse(path).root;
  for (const segment of path.split(sep)) {
    if (segment === '..') landing = dirname(landing);
    else if (segment !== '' && segment !== '.') {
      const next = await nameLanding(join(landing, segment), links);
      if (next === null) return null;
      landing = next;
    }
  }
  return landing;
}

async function nameLanding(path: string, links: { left: number }): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
  const stat = await lstat(path).catch((err: unknown) => {
    if (isENOENT(err)) return null;
    throw err;
  });
  if (!stat?.isSymbolicLink()) return path;
  if (links.left === 0) return null;
  links.left -= 1;
  const target = await readlink(path);
  return kernelLanding(isAbsolute(target) ? target : `${dirname(path)}${sep}${target}`, links);
}

/**
 * The target of a symlink that stays inside the project: a relative target that
 * climbs only in one leading run of `..` that stays inside the root, then names,
 * so it names the same place in the worktree and the staged copy; and that the
 * kernel lands inside the root and outside the control plane, following every
 * link on the way, dangling or not.
 * Null for any other entry; `readConfinedEntry` refuses every link.
 */
export async function readProjectSymlink(
  projectDir: string,
  relativePath: string,
): Promise<string | null> {
  const entry = await lstatConfinedEntry(projectDir, relativePath);
  if (entry === null || !entry.stat.isSymbolicLink()) return null;
  const target = await readlink(entry.fullPath);
  return (await linkStaysInProject(projectDir, relativePath, target)) ? target : null;
}

/** A link to `target` at `relativePath` stays inside the project, as `readProjectSymlink` reads one. */
export async function linkStaysInProject(
  projectDir: string,
  relativePath: string,
  target: string,
): Promise<boolean> {
  if (isAbsolute(target)) return false;
  const fullPath = resolve(projectDir, relativePath);
  // The kernel resolves a name before the `..` after it, so a `..` behind a
  // symlinked name climbs from wherever that link points. A climb above the root
  // that comes back down through the root's own name reads as inside here, yet
  // names another place in the worktree.
  const linkDir = relative(projectDir, dirname(fullPath));
  let depth = linkDir === '' ? 0 : linkDir.split(sep).length;
  let named = false;
  for (const segment of target.split('/')) {
    if (segment === '..') {
      depth -= 1;
      if (named || depth < 0) return false;
    } else if (segment !== '' && segment !== '.') {
      named = true;
    }
  }
  let landed: string | null;
  try {
    landed = await kernelLanding(`${dirname(fullPath)}${sep}${target}`);
  } catch {
    // A loop, or a file or an unreadable directory on the way: it lands nowhere.
    return false;
  }
  if (landed === null) return false;
  // A link into `.git` or `.splitbrief` gives the control plane a second name.
  const first = relative(await realpath(projectDir), landed).split(sep)[0] ?? '';
  return first !== '..' && !CONTROL_PLANE_SEGMENTS.has(first);
}
