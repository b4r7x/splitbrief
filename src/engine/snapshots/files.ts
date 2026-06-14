import { createHash } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { checkIgnoredPaths } from '../../lib/git.js';
import { INTERNAL_SKIP_DIRS } from '../../core/paths.js';

export type CollectTrackedFilesOptions = {
  ignoreProjectDir?: string | undefined;
};

export async function hashFile(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', () => resolve(null));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export const ALWAYS_EXCLUDED = INTERNAL_SKIP_DIRS;

async function readdirRecursive(dir: string, base: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    const name = entry.name as string;
    const rel = relative(base, join(dir, name));
    const topLevel = rel.split(/[/\\]/)[0];
    if (topLevel !== undefined && ALWAYS_EXCLUDED.includes(topLevel)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const children = await readdirRecursive(join(dir, name), base);
      results.push(...children);
    } else {
      results.push(rel);
    }
  }
  return results;
}

export async function collectTrackedFiles(
  projectDir: string,
  opts: CollectTrackedFilesOptions = {},
): Promise<string[]> {
  const allFiles = await readdirRecursive(projectDir, projectDir);
  if (allFiles.length === 0) return [];

  const ignoredPaths = await checkIgnoredPaths(opts.ignoreProjectDir ?? projectDir, allFiles);

  const ignored = new Set(ignoredPaths);
  const filtered = allFiles.filter((rel) => !ignored.has(rel));
  filtered.sort();
  return filtered;
}
