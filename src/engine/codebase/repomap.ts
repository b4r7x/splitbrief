import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { initParser, parseFile } from './parse.js';
import { createParseCache } from './cache.js';
import { resolveCodebaseCacheDir, resolveRepoMapDbPath } from './cache-path.js';
import { buildGraph } from './graph.js';
import { pagerank } from './pagerank.js';
import { formatWithBudget } from './budget.js';
import { extractMentionedFilenames } from './extract-mentioned-filenames.js';
import { ALL_KNOWN_EXTENSIONS } from './languages.js';

export interface RepoMapOptions {
  focusFiles?: string[];
  featureText?: string;
  tokenBudget?: number;
  cacheDir?: string;
  include?: string[];
  exclude?: string[];
}

const DEFAULT_EXCLUDE_PATTERNS = [
  /\.test\.tsx?$/,
  /node_modules\//,
  /dist\//,
  /\.diptych\//,
];

export async function buildRepoMap(projectDir: string, opts: RepoMapOptions = {}): Promise<string> {
  await initParser();

  const tokenBudget = opts.tokenBudget ?? 4000;
  const cacheDir = resolveCodebaseCacheDir(projectDir, opts.cacheDir);
  await mkdir(cacheDir, { recursive: true });
  const cache = createParseCache(resolveRepoMapDbPath(projectDir, opts.cacheDir));

  try {
    const absFiles = await discoverFiles(projectDir, {
      cacheDir,
      ...(opts.exclude ? { excludePatterns: opts.exclude } : {}),
      ...(opts.include ? { includePatterns: opts.include } : {}),
    });
    if (absFiles.length === 0) return '';

    const parsedNodes = await Promise.all(absFiles.map(f => cache.getOrParse(f, parseFile)));
    const nodesAbs = parsedNodes.filter((node): node is NonNullable<typeof node> => node !== null);
    if (nodesAbs.length === 0) return '';

    const graph = buildGraph(nodesAbs);
    const discoveredPaths = nodesAbs.map(n => n.path);
    const mentionedFiles = opts.featureText
      ? extractMentionedFilenames(opts.featureText, projectDir, discoveredPaths)
      : [];
    const explicitFocusFiles = (opts.focusFiles ?? []).map(f =>
      isAbsolute(f) ? f : resolve(projectDir, f)
    );
    const absFocusFiles = [...new Set([...explicitFocusFiles, ...mentionedFiles])];
    const rankings = pagerank(graph, absFocusFiles);

    const displayNodes = nodesAbs.map(n => ({ ...n, path: relative(projectDir, n.path) }));
    const rankingsByRelPath = new Map<string, number>();
    for (const [absPath, rank] of rankings) {
      rankingsByRelPath.set(relative(projectDir, absPath), rank);
    }

    return formatWithBudget(displayNodes, rankingsByRelPath, tokenBudget);
  } finally {
    cache.close();
  }
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

function createDefaultExcludePatterns(projectDir: string, cacheDir: string): RegExp[] {
  const cacheRelPath = normalizeRelativePath(relative(projectDir, cacheDir));
  if (cacheRelPath === '' || cacheRelPath.startsWith('..') || isAbsolute(cacheRelPath)) {
    return DEFAULT_EXCLUDE_PATTERNS;
  }
  return [
    ...DEFAULT_EXCLUDE_PATTERNS,
    new RegExp(`^${escapeRegExp(cacheRelPath)}(?:/|$)`),
  ];
}

async function discoverFiles(projectDir: string, opts: DiscoverOptions): Promise<string[]> {
  const exclude = opts.excludePatterns
    ? opts.excludePatterns.map(p => new RegExp(p))
    : createDefaultExcludePatterns(projectDir, opts.cacheDir);
  const include = opts.includePatterns?.length
    ? opts.includePatterns.map(createIncludeMatcher)
    : null;
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(projectDir, abs);
      const relPath = normalizeRelativePath(rel);
      if (exclude.some(re => re.test(relPath))) continue;
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
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
