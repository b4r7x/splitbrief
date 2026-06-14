import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { listTrackedAndUntrackedFiles } from './git.js';

export const MAX_PROJECT_FILES = 10_000;

const ALWAYS_EXCLUDE: RegExp[] = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(?:^|\/)credentials\./i,
  /(?:^|\/)\.git\//,
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

export interface ListProjectFilesOptions {
  excludePatterns?: RegExp[];
  skipRelativeDirs?: string[];
}

function isExcluded(filePath: string, extra: RegExp[]): boolean {
  return ALWAYS_EXCLUDE.some((re) => re.test(filePath)) || extra.some((re) => re.test(filePath));
}

function shouldSkipDirectory(name: string, rel: string, skipRelativeDirs: Set<string>): boolean {
  return SKIP_DIRS.has(name) || skipRelativeDirs.has(rel);
}

async function listViaReaddir(
  dir: string,
  base: string,
  result: string[],
  skipRelativeDirs: Set<string>,
): Promise<void> {
  if (result.length >= MAX_PROJECT_FILES) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (result.length >= MAX_PROJECT_FILES) return;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name, rel, skipRelativeDirs)) {
        await listViaReaddir(join(dir, entry.name), rel, result, skipRelativeDirs);
      }
      continue;
    }
    result.push(rel);
  }
}

async function listViaFilesystem(
  projectDir: string,
  skipRelativeDirs: Set<string>,
): Promise<string[]> {
  const result: string[] = [];
  await listViaReaddir(projectDir, '', result, skipRelativeDirs);
  return result;
}

export async function listProjectFiles(
  projectDir: string,
  options: ListProjectFilesOptions = {},
): Promise<string[]> {
  const extraPatterns = options.excludePatterns ?? [];
  const skipRelativeDirs = new Set(options.skipRelativeDirs ?? []);
  const files =
    (await listTrackedAndUntrackedFiles(projectDir)) ??
    (await listViaFilesystem(projectDir, skipRelativeDirs));
  const filtered = files.filter((file) => !isExcluded(file, extraPatterns));
  filtered.sort();
  if (filtered.length > MAX_PROJECT_FILES) return filtered.slice(0, MAX_PROJECT_FILES);
  return filtered;
}
