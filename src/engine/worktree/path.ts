import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { TREES_DIR, worktreePath } from '../../core/paths.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
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
