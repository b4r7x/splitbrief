import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveFromProject } from '../../utils/path-patterns.js';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { initParser, parseFile } from './parse.js';
import { createParseCache } from './cache.js';
import { resolveCodebaseCacheDir, resolveRepoMapDbPath } from './cache-path.js';
import { buildGraph } from './graph.js';
import { pagerank } from './pagerank.js';
import { formatWithBudget } from './budget.js';
import { extractMentionedFilenames } from './extract-mentioned-filenames.js';
import { ALL_KNOWN_EXTENSIONS } from './languages.js';

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

const DEFAULT_EXCLUDE_DIR_NAMES = new Set(['node_modules', '.git', 'dist', '.diptych']);

const DEFAULT_EXCLUDE_FILE_PATTERNS = [
  /\.test\.tsx?$/,
];

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

    const parsedNodes = await parseWithConcurrencyLimit(absFiles, f => c.getOrParse(f, parseFile), PARSE_CONCURRENCY);
    const nodesAbs = parsedNodes.filter((node): node is NonNullable<typeof node> => node !== null);
    if (nodesAbs.length === 0) return '';

    const graph = buildGraph(nodesAbs);
    const discoveredPaths = nodesAbs.map(n => n.path);
    const mentionedFiles = opts.featureText
      ? extractMentionedFilenames(opts.featureText, projectDir, discoveredPaths)
      : [];
    const explicitFocusFiles = (opts.focusFiles ?? []).map(f => resolveFromProject(projectDir, f));
    const absFocusFiles = [...new Set([...explicitFocusFiles, ...mentionedFiles])];
    const rankings = pagerank(graph, absFocusFiles);

    const displayNodes = nodesAbs.map(n => ({ ...n, path: relative(projectDir, n.path) }));
    const rankingsByRelPath = new Map<string, number>();
    for (const [absPath, rank] of rankings) {
      rankingsByRelPath.set(relative(projectDir, absPath), rank);
    }

    return formatWithBudget(displayNodes, rankingsByRelPath, tokenBudget);
  } catch (err) {
    console.warn(`repo-map unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
      const file = files[idx]!;
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

interface DiscoverOptions {
  excludePatterns?: string[];
  includePatterns?: string[];
  cacheDir: string;
}

type IncludeMatcher = (relPath: string, ext: string) => boolean;

function normalizePathPattern(pattern: string): string {
  return pattern.replaceAll('\\', '/').replace(/^\.\//, '');
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSimpleExtensionPattern(pattern: string): string | null {
  const match = pattern.match(/^\*\.([A-Za-z0-9]+)$/);
  return match?.[1] ? `.${match[1]}` : null;
}

function extractGlobExtension(pattern: string): string | null {
  const match = pattern.match(/\.([A-Za-z0-9]+)$/);
  return match?.[1] ? `.${match[1]}` : null;
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? '';
    const next = pattern[i + 1];

    if (ch === '*' && next === '*') {
      const afterGlobstar = pattern[i + 2];
      if (afterGlobstar === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i++;
      }
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(ch);
    }
  }
  return new RegExp(`${source}$`);
}

function createIncludeMatcher(pattern: string): IncludeMatcher {
  const normalized = normalizePathPattern(pattern.trim());
  const simpleExtension = extractSimpleExtensionPattern(normalized);
  if (simpleExtension) {
    return (_relPath, ext) => ext === simpleExtension;
  }

  const regex = globToRegExp(normalized);
  const globExtension = extractGlobExtension(normalized);
  return (relPath, ext) =>
    regex.test(relPath) && (globExtension !== null ? ext === globExtension : ALL_KNOWN_EXTENSIONS.has(ext));
}

function buildExcludeDirNames(projectDir: string, cacheDir: string): Set<string> {
  const names = new Set(DEFAULT_EXCLUDE_DIR_NAMES);
  const cacheRelPath = normalizeRelativePath(relative(projectDir, cacheDir));
  if (cacheRelPath && !cacheRelPath.startsWith('..') && !isAbsolute(cacheRelPath)) {
    const topSegment = cacheRelPath.split('/')[0];
    if (topSegment) names.add(topSegment);
  }
  return names;
}

function buildFileExcludePatterns(userPatterns?: string[]): RegExp[] {
  if (!userPatterns?.length) return DEFAULT_EXCLUDE_FILE_PATTERNS;
  return [...DEFAULT_EXCLUDE_FILE_PATTERNS, ...userPatterns.map(p => new RegExp(p))];
}

async function discoverFiles(projectDir: string, opts: DiscoverOptions): Promise<string[]> {
  const excludeDirNames = buildExcludeDirNames(projectDir, opts.cacheDir);
  const excludeFilePatterns = buildFileExcludePatterns(opts.excludePatterns);
  const userDirPatterns = opts.excludePatterns?.length
    ? opts.excludePatterns.map(p => new RegExp(p))
    : [];
  const include = opts.includePatterns?.length
    ? opts.includePatterns.map(createIncludeMatcher)
    : null;
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (excludeDirNames.has(entry.name)) continue;
        if (userDirPatterns.length > 0) {
          const dirRel = normalizeRelativePath(relative(projectDir, join(dir, entry.name)));
          if (userDirPatterns.some(re => re.test(dirRel) || re.test(dirRel + '/'))) continue;
        }
        await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const abs = join(dir, entry.name);
        const rel = relative(projectDir, abs);
        const relPath = normalizeRelativePath(rel);
        if (excludeFilePatterns.some(re => re.test(relPath))) continue;
        const ext = extname(abs);
        const isIncluded = include
          ? include.some(matcher => matcher(relPath, ext))
          : ALL_KNOWN_EXTENSIONS.has(ext);
        if (isIncluded) out.push(resolve(abs));
      }
    }
  }

  await walk(projectDir);
  return out.sort();
}
