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

export const CONCRETE_FILE_PATH_PATTERN = /\b(?:[a-zA-Z][a-zA-Z0-9_-]*\/)+[a-zA-Z][a-zA-Z0-9._-]*\.[a-zA-Z]{1,5}\b/g;

export function resolveFromProject(projectDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(projectDir, p);
}
