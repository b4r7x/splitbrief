import { relative } from 'node:path';
import { resolveFromProject } from '../../utils/path-patterns.js';
import { mkdir, stat } from 'node:fs/promises';
import { warnError } from '../../lib/warn.js';
import { initParser, parseFile } from './parse.js';
import { createParseCache } from './cache.js';
import { resolveCodebaseCacheDir, resolveRepoMapDbPath } from './cache-path.js';
import { buildGraph } from './graph.js';
import { pagerank } from './pagerank.js';
import { formatWithBudget } from './budget.js';
import { extractMentionedFilenames } from './extract-mentioned-filenames.js';
import { discoverFiles } from './discover-files.js';

export const MAX_FILE_SIZE_BYTES = 100_000;
export const PARSE_CONCURRENCY = 8;

export interface RepoMapOptions {
  focusFiles?: string[];
  featureText?: string;
  tokenBudget?: number;
  cacheDir?: string;
  include?: string[];
  exclude?: string[];
}

export async function buildRepoMap(projectDir: string, opts: RepoMapOptions = {}): Promise<string> {
  let cache: Awaited<ReturnType<typeof createParseCache>> | null = null;
  try {
    await initParser();

    const tokenBudget = opts.tokenBudget ?? 4000;
    const cacheDir = resolveCodebaseCacheDir(projectDir, opts.cacheDir);
    await mkdir(cacheDir, { recursive: true });
    cache = await createParseCache(resolveRepoMapDbPath(projectDir, opts.cacheDir));
    const c = cache;

    const absFiles = await discoverFiles(projectDir, {
      cacheDir,
      ...(opts.exclude ? { excludePatterns: opts.exclude } : {}),
      ...(opts.include ? { includePatterns: opts.include } : {}),
    });
    if (absFiles.length === 0) return '';

    const parsedNodes = await parseWithConcurrencyLimit(
      absFiles,
      (f) => c.getOrParse(f, parseFile),
      PARSE_CONCURRENCY,
    );
    const nodesAbs = parsedNodes.filter((node): node is NonNullable<typeof node> => node !== null);
    if (nodesAbs.length === 0) return '';

    const graph = buildGraph(nodesAbs);
    const discoveredPaths = nodesAbs.map((n) => n.path);
    const mentionedFiles = opts.featureText
      ? extractMentionedFilenames(opts.featureText, projectDir, discoveredPaths)
      : [];
    const explicitFocusFiles = (opts.focusFiles ?? []).map((f) =>
      resolveFromProject(projectDir, f),
    );
    const absFocusFiles = [...new Set([...explicitFocusFiles, ...mentionedFiles])];
    const rankings = pagerank(graph, absFocusFiles);

    const displayNodes = nodesAbs.map((n) => ({ ...n, path: relative(projectDir, n.path) }));
    const rankingsByRelPath = new Map<string, number>();
    for (const [absPath, rank] of rankings) {
      rankingsByRelPath.set(relative(projectDir, absPath), rank);
    }

    return formatWithBudget(displayNodes, rankingsByRelPath, tokenBudget);
  } catch (err) {
    warnError('repo-map unavailable', err);
    return '';
  } finally {
    cache?.close();
  }
}

async function parseWithConcurrencyLimit<T>(
  files: string[],
  parseFn: (file: string) => Promise<T | null>,
  concurrency: number,
): Promise<(T | null)[]> {
  const results: (T | null)[] = new Array(files.length).fill(null) as (T | null)[];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < files.length) {
      const idx = nextIndex++;
      const file = files[idx];
      if (!file) continue;
      try {
        const fileStat = await stat(file);
        if (fileStat.size > MAX_FILE_SIZE_BYTES) continue;
      } catch {
        continue;
      }
      results[idx] = await parseFn(file);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
