import { isAbsolute, resolve } from 'node:path';

const ROOT_FILE_NAMES = new Set([
  'Dockerfile',
  'Makefile',
  'README',
  'LICENSE',
  'CHANGELOG',
  'NOTICE',
  'Procfile',
]);

export function looksLikeFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('*')) return true;
  if (/\s/.test(trimmed)) return false;
  if (trimmed.startsWith('.') && trimmed.length > 1) return true;
  if (/^[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(trimmed)) return true;
  return ROOT_FILE_NAMES.has(trimmed);
}

export const CONCRETE_FILE_PATH_PATTERN =
  /\b(?:[a-zA-Z][a-zA-Z0-9_-]*\/)+[a-zA-Z][a-zA-Z0-9._-]*\.[a-zA-Z]{1,5}\b/g;

export function resolveFromProject(projectDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(projectDir, p);
}

export function matchesGlob(filePath: string, pattern: string): boolean {
  if (pattern === filePath) return true;

  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return filePath.startsWith(`${prefix}/`) || filePath === prefix;
  }

  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    const rest = filePath.slice(prefix.length + 1);
    return filePath.startsWith(`${prefix}/`) && !rest.includes('/');
  }

  if (pattern.startsWith('*.')) {
    return filePath.endsWith(pattern.slice(1));
  }

  if (pattern.includes('*')) {
    const starIdx = pattern.indexOf('*');
    const beforeStar = pattern.slice(0, starIdx);
    const afterStar = pattern.slice(starIdx + 1);
    return filePath.startsWith(beforeStar) && (afterStar === '' || filePath.endsWith(afterStar));
  }

  return false;
}
