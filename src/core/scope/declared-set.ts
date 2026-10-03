import {
  matchesGlob,
  normalizeProjectRelativePath,
  scopePathPatterns,
} from '../../utils/path-patterns.js';
import type { Task } from '../schemas/task.js';
import { taskFiles } from '../schemas/task.js';

/** A planner-approved scope bullet names its path, root-level files included; a bare backticked identifier is prose. */
const LEADING_PATH = /^\s*`([^`\s]+)`\s*—\s*planner-approved:/;

const SCOPE_PLACEHOLDERS = new Set(['none', 'none.', 'n/a', '-']);

/** A Scope bullet that only says the list is empty (`- None.`), never a path. */
export function isScopePlaceholder(entry: string): boolean {
  return SCOPE_PLACEHOLDERS.has(entry.trim().toLowerCase());
}

/** Path tokens a Scope bullet licenses; a whitespace-free bullet is itself a pattern (`tsconfig.json`). */
export function scopeEntryPatterns(entry: string): string[] {
  if (isScopePlaceholder(entry)) return [];
  const leading = LEADING_PATH.exec(entry)?.[1];
  const patterns = [
    ...new Set([...scopePathPatterns(entry), ...(leading === undefined ? [] : [leading])]),
  ];
  if (patterns.length > 0) return patterns;
  // scopePathPatterns drops bare filenames (no separator or wildcard); a
  // whitespace-free entry is a literal pattern like `tsconfig.json`, not prose.
  const trimmed = entry.trim();
  return trimmed.length > 0 && !/\s/.test(trimmed) ? [trimmed] : [];
}

/** `file` matches `entry` when any pattern the entry licenses equals it or globs it. */
export function matchesScopeEntry(file: string, entry: string): boolean {
  const normalized = normalizeProjectRelativePath(file);
  return scopeEntryPatterns(entry).some((pattern) =>
    matchesGlob(normalized, normalizeProjectRelativePath(pattern)),
  );
}

/** Patterns a brief may write: its files plus every In-bounds and Approved-out-of-bounds bullet. */
export function taskDeclaredPatterns(task: Task): readonly string[] {
  return [
    ...taskFiles(task),
    ...(task.scope?.inBounds ?? []),
    ...(task.scope?.approvedOutOfBounds ?? []),
  ];
}

export function isInDeclaredSet(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesScopeEntry(file, pattern));
}

export function undeclaredFiles(changed: readonly string[], task: Task): string[] {
  const declared = taskDeclaredPatterns(task);
  return changed.filter((file) => !isInDeclaredSet(file, declared));
}
