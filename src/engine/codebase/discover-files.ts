import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { ALL_KNOWN_EXTENSIONS } from './languages.js';
import { DIPTYCH_DIR, SANDBOX_DIR, TREES_DIR } from '../../core/paths.js';
import { escapeRegExp } from '../../utils/regexp.js';

const DEFAULT_EXCLUDE_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  DIPTYCH_DIR,
  SANDBOX_DIR,
  TREES_DIR,
]);

const DEFAULT_EXCLUDE_FILE_PATTERNS = [/\.test\.tsx?$/];

export interface DiscoverOptions {
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
    regex.test(relPath) &&
    (globExtension !== null ? ext === globExtension : ALL_KNOWN_EXTENSIONS.has(ext));
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
  return [...DEFAULT_EXCLUDE_FILE_PATTERNS, ...userPatterns.map((p) => new RegExp(p))];
}

export async function discoverFiles(projectDir: string, opts: DiscoverOptions): Promise<string[]> {
  const excludeDirNames = buildExcludeDirNames(projectDir, opts.cacheDir);
  const excludeFilePatterns = buildFileExcludePatterns(opts.excludePatterns);
  const userDirPatterns = opts.excludePatterns?.length
    ? opts.excludePatterns.map((p) => new RegExp(p))
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
          if (userDirPatterns.some((re) => re.test(dirRel) || re.test(dirRel + '/'))) continue;
        }
        await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const abs = join(dir, entry.name);
        const rel = relative(projectDir, abs);
        const relPath = normalizeRelativePath(rel);
        if (excludeFilePatterns.some((re) => re.test(relPath))) continue;
        const ext = extname(abs);
        const isIncluded = include
          ? include.some((matcher) => matcher(relPath, ext))
          : ALL_KNOWN_EXTENSIONS.has(ext);
        if (isIncluded) out.push(resolve(abs));
      }
    }
  }

  await walk(projectDir);
  return out.sort();
}
