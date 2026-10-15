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

type ProjectEntry = { path: string; kind: 'file' | 'symlink' | 'directory' };

export async function* walkProjectEntries(
  projectDir: string,
  opts: CollectTrackedFilesOptions = {},
): AsyncGenerator<ProjectEntry> {
  const ignoreDir = opts.ignoreProjectDir ?? projectDir;
  let level = [''];
  while (level.length > 0) {
    const candidates: ProjectEntry[] = [];
    for (const rel of level) {
      for (const entry of await readdir(join(projectDir, rel), {
        withFileTypes: true,
        encoding: 'utf8',
      })) {
        if (ALWAYS_EXCLUDED.includes(entry.name)) continue;
        const kind = entry.isDirectory()
          ? 'directory'
          : entry.isSymbolicLink()
            ? 'symlink'
            : entry.isFile()
              ? 'file'
              : null;
        if (kind === null) continue;
        const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
        candidates.push({ path, kind });
      }
    }
    const ignored = new Set(
      await checkIgnoredPaths(
        ignoreDir,
        candidates.map((entry) => (entry.kind === 'directory' ? `${entry.path}/` : entry.path)),
      ),
    );
    level = [];
    for (const entry of candidates) {
      if (ignored.has(entry.kind === 'directory' ? `${entry.path}/` : entry.path)) continue;
      if (entry.kind === 'directory') level.push(entry.path);
      yield entry;
    }
  }
}

export async function collectTrackedFiles(
  projectDir: string,
  opts: CollectTrackedFilesOptions = {},
): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of walkProjectEntries(projectDir, opts)) {
    if (entry.kind === 'file') files.push(entry.path);
  }
  return files.sort();
}

/** Every file and link under `projectDir` the snapshots would record, sorted. */
export async function listWorkspaceEntries(
  projectDir: string,
  opts: CollectTrackedFilesOptions = {},
): Promise<string[]> {
  const entries: string[] = [];
  for await (const entry of walkProjectEntries(projectDir, opts)) {
    if (entry.kind !== 'directory') entries.push(entry.path);
  }
  return entries.sort();
}
