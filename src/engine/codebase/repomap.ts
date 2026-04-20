import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { initParser, parseFile } from './parse.js';
import { createParseCache } from './cache.js';
import { buildGraph } from './graph.js';
import { pagerank } from './pagerank.js';
import { formatWithBudget } from './budget.js';
import { extractMentionedFilenames } from './extract-mentioned-filenames.js';

export interface RepoMapOptions {
  focusFiles?: string[];
  featureText?: string;
  tokenBudget?: number;
  include?: string[];
  exclude?: string[];
}

const DEFAULT_INCLUDE_EXTS = new Set(['.ts', '.tsx']);
const DEFAULT_EXCLUDE_PATTERNS = [
  /\.test\.tsx?$/,
  /node_modules\//,
  /dist\//,
  /\.diptych\//,
];

export async function buildRepoMap(projectDir: string, opts: RepoMapOptions = {}): Promise<string> {
  await initParser();

  const tokenBudget = opts.tokenBudget ?? 4000;
  const cacheDir = join(projectDir, '.diptych');
  mkdirSync(cacheDir, { recursive: true });
  const cache = createParseCache(join(cacheDir, 'repomap.sqlite'));

  const absFiles = await discoverFiles(projectDir, opts.exclude);
  if (absFiles.length === 0) return '';

  const nodesAbs = await Promise.all(absFiles.map(f => cache.getOrParse(f, parseFile)));

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
}

async function discoverFiles(projectDir: string, excludePatterns?: string[]): Promise<string[]> {
  const exclude = excludePatterns
    ? excludePatterns.map(p => new RegExp(p))
    : DEFAULT_EXCLUDE_PATTERNS;
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(projectDir, abs);
      if (exclude.some(re => re.test(rel))) continue;
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const ext = extname(abs);
        if (DEFAULT_INCLUDE_EXTS.has(ext)) out.push(resolve(abs));
      }
    }
  }

  await walk(projectDir);
  return out.sort();
}
