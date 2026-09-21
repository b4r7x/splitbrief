import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { checkIgnoredPaths } from '../../lib/git/files.js';
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

type DirectoryListing = { files: string[]; dirs: string[] };

async function listDirectory(projectDir: string, rel: string): Promise<DirectoryListing> {
  const dir = rel === '' ? projectDir : join(projectDir, rel);
  const entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  const listing: DirectoryListing = { files: [], dirs: [] };
  for (const entry of entries) {
    const name = entry.name as string;
    if (ALWAYS_EXCLUDED.includes(name) || entry.isSymbolicLink()) continue;
    const childRel = rel === '' ? name : `${rel}/${name}`;
    if (entry.isDirectory()) listing.dirs.push(childRel);
    else listing.files.push(childRel);
  }
  return listing;
}

/**
 * Breadth-first, one `git check-ignore` per depth for the directories found
 * there: an ignored tree — node_modules, .venv, target, build, whatever the
 * stack ignores — is never entered. Files are filtered the same way at the end.
 */
export async function collectTrackedFiles(
  projectDir: string,
  opts: CollectTrackedFilesOptions = {},
): Promise<string[]> {
  const ignoreDir = opts.ignoreProjectDir ?? projectDir;
  const files: string[] = [];
  let level = [''];
  while (level.length > 0) {
    const dirs: string[] = [];
    for (const rel of level) {
      const listing = await listDirectory(projectDir, rel);
      for (const file of listing.files) files.push(file);
      for (const dir of listing.dirs) dirs.push(dir);
    }
    const ignoredDirs = new Set(
      await checkIgnoredPaths(
        ignoreDir,
        dirs.map((dir) => `${dir}/`),
      ),
    );
    level = dirs.filter((dir) => !ignoredDirs.has(`${dir}/`));
  }
  if (files.length === 0) return [];

  const ignored = new Set(await checkIgnoredPaths(ignoreDir, files));
  const filtered = files.filter((rel) => !ignored.has(rel));
  filtered.sort();
  return filtered;
}
