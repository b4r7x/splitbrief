import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

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

function listViaGit(projectDir: string): string[] | null {
  try {
    const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function shouldSkipDirectory(name: string, rel: string, skipRelativeDirs: Set<string>): boolean {
  return SKIP_DIRS.has(name) || skipRelativeDirs.has(rel);
}

function listViaReaddir(
  dir: string,
  base: string,
  result: string[],
  skipRelativeDirs: Set<string>,
): void {
  if (result.length >= MAX_PROJECT_FILES) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (result.length >= MAX_PROJECT_FILES) return;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name, rel, skipRelativeDirs)) {
        listViaReaddir(join(dir, entry.name), rel, result, skipRelativeDirs);
      }
      continue;
    }
    result.push(rel);
  }
}

function listViaFilesystem(projectDir: string, skipRelativeDirs: Set<string>): string[] {
  const result: string[] = [];
  listViaReaddir(projectDir, '', result, skipRelativeDirs);
  return result;
}

export function listProjectFiles(
  projectDir: string,
  options: ListProjectFilesOptions = {},
): string[] {
  const extraPatterns = options.excludePatterns ?? [];
  const skipRelativeDirs = new Set(options.skipRelativeDirs ?? []);
  const files = listViaGit(projectDir) ?? listViaFilesystem(projectDir, skipRelativeDirs);
  const filtered = files.filter((file) => !isExcluded(file, extraPatterns));
  filtered.sort();
  if (filtered.length > MAX_PROJECT_FILES) return filtered.slice(0, MAX_PROJECT_FILES);
  return filtered;
}
