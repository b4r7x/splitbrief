import { existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  isolationTreesRoot,
  isolationWorktreePath,
  isolationWorktreeRoot,
  TREES_DIR,
  worktreePath,
} from '../../core/paths.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
  isInsideRoot,
  nearestExistingAncestor,
  pathConfinementError,
} from '../../lib/path-confinement.js';
import { worktreeError } from './errors.js';

const WORKTREE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

function isTreesPathEscape(err: unknown): boolean {
  return (
    pathConfinementError.isSymlinkParent(err) ||
    pathConfinementError.isSymlinkRead(err) ||
    (err instanceof Error && (err as { kind?: unknown }).kind === 'path-confined-escape')
  );
}

export function validateWorktreeName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw worktreeError.nameRequired();
  }
  if (name.length > 64) {
    throw worktreeError.nameTooLong(name);
  }
  if (name.startsWith('.') || name.startsWith('-')) {
    throw worktreeError.nameBadPrefix(name);
  }
  if (name === '.' || name === '..') {
    throw worktreeError.nameReserved(name);
  }
  if (name.includes('/') || name.includes('\\') || name.includes(sep)) {
    throw worktreeError.nameHasPathSeparator(name);
  }
  if (!WORKTREE_NAME_RE.test(name)) {
    throw worktreeError.nameInvalidCharacters(name);
  }
}

export function resolveConfinedWorktreePath(projectDir: string, slug: string): string {
  validateWorktreeName(slug);
  try {
    assertWritablePathConfined(TREES_DIR, projectDir);
    assertWritablePathConfined(join(TREES_DIR, slug), projectDir);
  } catch (err) {
    if (isTreesPathEscape(err)) throw worktreeError.treesPathEscape();
    throw err;
  }
  return worktreePath(projectDir, slug);
}

export function assertTreesDirReadable(projectDir: string): void {
  const treesDir = join(projectDir, TREES_DIR);
  if (!existsSync(treesDir)) return;
  try {
    assertExistingPathConfined(TREES_DIR, projectDir);
  } catch (err) {
    if (isTreesPathEscape(err)) throw worktreeError.treesPathEscape();
    throw err;
  }
}

function assertIsolationPathsExternal(opts: {
  projectDir: string;
  gitCommonDir: string;
  candidates: readonly string[];
}): void {
  const forbiddenRoots = [opts.projectDir, opts.gitCommonDir];
  for (const candidate of opts.candidates) {
    const lexicalCandidate = resolve(candidate);
    if (forbiddenRoots.some((root) => isInsideRoot(resolve(root), lexicalCandidate))) {
      throw worktreeError.isolationPathOverlap();
    }
  }
  const canonicalForbiddenRoots = forbiddenRoots.map((root) => realpathSync(root));
  for (const candidate of opts.candidates) {
    const canonicalCandidate = nearestExistingAncestor(candidate);
    if (canonicalForbiddenRoots.some((root) => isInsideRoot(root, canonicalCandidate))) {
      throw worktreeError.isolationPathOverlap();
    }
  }
}

export function resolveConfinedIsolationWorktreePath(opts: {
  projectDir: string;
  gitCommonDir: string;
  slug: string;
}): string {
  const { projectDir, gitCommonDir, slug } = opts;
  validateWorktreeName(slug);
  const treesRoot = isolationTreesRoot();
  const repositoryRoot = isolationWorktreeRoot(gitCommonDir);
  const worktree = isolationWorktreePath(gitCommonDir, slug);
  assertIsolationPathsExternal({
    projectDir,
    gitCommonDir,
    candidates: [treesRoot, repositoryRoot, worktree],
  });
  try {
    assertWritablePathConfined(relative(treesRoot, repositoryRoot), treesRoot);
    assertWritablePathConfined(relative(treesRoot, worktree), treesRoot);
  } catch (err) {
    if (isTreesPathEscape(err)) throw worktreeError.isolationPathEscape();
    throw err;
  }
  return worktree;
}

export function assertIsolationDirReadable(opts: {
  projectDir: string;
  gitCommonDir: string;
}): void {
  const { projectDir, gitCommonDir } = opts;
  const treesRoot = isolationTreesRoot();
  const repositoryRoot = isolationWorktreeRoot(gitCommonDir);
  assertIsolationPathsExternal({
    projectDir,
    gitCommonDir,
    candidates: [treesRoot, repositoryRoot],
  });
  if (!existsSync(repositoryRoot)) return;
  try {
    assertExistingPathConfined(relative(treesRoot, repositoryRoot), treesRoot);
  } catch (err) {
    if (isTreesPathEscape(err)) throw worktreeError.isolationPathEscape();
    throw err;
  }
}
