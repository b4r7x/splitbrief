import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ALWAYS_EXCLUDE: RegExp[] = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(?:^|\/)credentials\./i,
  /(?:^|\/)\.diptych\/sessions\//,
  /(?:^|\/)\.git\//,
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

function isExcluded(filePath: string): boolean {
  return ALWAYS_EXCLUDE.some((re) => re.test(filePath));
}

function listViaGit(projectDir: string): string[] | null {
  try {
    const output = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: projectDir, encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function shouldSkipDirectory(name: string, rel: string): boolean {
  return SKIP_DIRS.has(name) || rel === '.diptych/sessions';
}

function listViaReaddir(dir: string, base: string, result: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name, rel)) {
        listViaReaddir(join(dir, entry.name), rel, result);
      }
      continue;
    }
    result.push(rel);
  }
}

function listViaFilesystem(projectDir: string): string[] {
  const result: string[] = [];
  listViaReaddir(projectDir, '', result);
  return result;
}

export function listProjectFiles(projectDir: string): string[] {
  const files = listViaGit(projectDir) ?? listViaFilesystem(projectDir);
  return files.filter((file) => !isExcluded(file)).sort();
}
