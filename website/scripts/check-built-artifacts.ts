import { readFile, stat } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { sitePages, type SitePage } from './pages.js';
import { OUTPUT_PATH, requireSiteUrl } from './site.js';

export const SEARCH_RAW_BYTE_LIMIT = 3_000_000;
export const SEARCH_GZIP_BYTE_LIMIT = 650_000;
const LLMS_INDEX_BYTE_LIMIT = 5_120;

type BuiltArtifactOptions = {
  readonly outputDirectory?: string;
  readonly pages?: readonly SitePage[];
  readonly siteOrigin: string;
};

function relativeOutputPath(page: SitePage): string {
  if (page.prerender) {
    return page.prerender.outputPath.replace(/^\/+/, '');
  }
  if (page.path === '/') {
    return 'index.html';
  }

  const routePath = page.path.replace(/^\/+/, '');
  return page.kind === 'page' || page.path === '/og'
    ? posix.join(routePath, 'index.html')
    : routePath;
}

async function readArtifact(
  path: string,
  label: string,
  violations: string[],
): Promise<Buffer | undefined> {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size === 0) {
      violations.push(`${label} is missing or empty`);
      return undefined;
    }
    return await readFile(path);
  } catch {
    violations.push(`${label} is missing or unreadable`);
    return undefined;
  }
}

function expectedSitemapLocations(pages: readonly SitePage[], siteOrigin: string): string[] {
  return pages
    .filter((page) => page.kind === 'page')
    .map((page) => `<loc>${new URL(page.path, `${siteOrigin}/`).href}</loc>`)
    .sort();
}

export async function builtArtifactViolations({
  outputDirectory = OUTPUT_PATH,
  pages = sitePages(),
  siteOrigin,
}: BuiltArtifactOptions): Promise<string[]> {
  const canonicalOrigin = requireSiteUrl(siteOrigin);
  const violations: string[] = [];
  const routeArtifacts = new Map<string, Buffer>();

  for (const page of pages) {
    const relativePath = relativeOutputPath(page);
    const contents = await readArtifact(
      join(outputDirectory, relativePath),
      relativePath,
      violations,
    );
    if (contents) {
      routeArtifacts.set(page.path, contents);
    }
  }

  const [robots, sitemap] = await Promise.all([
    readArtifact(join(outputDirectory, 'robots.txt'), 'robots.txt', violations),
    readArtifact(join(outputDirectory, 'sitemap.xml'), 'sitemap.xml', violations),
  ]);
  await Promise.all([
    readArtifact(join(outputDirectory, 'og.png'), 'og.png', violations),
    readArtifact(
      join(outputDirectory, 'THIRD_PARTY_NOTICES.txt'),
      'THIRD_PARTY_NOTICES.txt',
      violations,
    ),
  ]);
  const llmsIndex = routeArtifacts.get('/llms.txt');
  const searchIndex = routeArtifacts.get('/api/search');

  if (llmsIndex) {
    if (llmsIndex.byteLength > LLMS_INDEX_BYTE_LIMIT) {
      violations.push(`llms.txt exceeds ${LLMS_INDEX_BYTE_LIMIT} bytes`);
    }
    const llmsText = llmsIndex.toString('utf8');
    for (const page of pages.filter(
      (candidate) => candidate.kind === 'page' && candidate.path.startsWith('/docs/'),
    )) {
      const mirrorUrl = `${canonicalOrigin}${page.path}.md`;
      if (!llmsText.includes(`](${mirrorUrl})`)) {
        violations.push(`llms.txt is missing ${mirrorUrl}`);
      }
    }
  }

  if (robots) {
    const sitemapUrl = `${canonicalOrigin}/sitemap.xml`;
    if (!robots.toString('utf8').includes(`Sitemap: ${sitemapUrl}`)) {
      violations.push(`robots.txt is missing ${sitemapUrl}`);
    }
  }

  if (sitemap) {
    const sitemapText = sitemap.toString('utf8');
    for (const location of expectedSitemapLocations(pages, canonicalOrigin)) {
      if (!sitemapText.includes(location)) {
        violations.push(`sitemap.xml is missing ${location}`);
      }
    }
    for (const page of pages.filter((candidate) => candidate.kind !== 'page')) {
      const excludedLocation = `<loc>${new URL(page.path, `${canonicalOrigin}/`).href}</loc>`;
      if (sitemapText.includes(excludedLocation)) {
        violations.push(`sitemap.xml must exclude ${page.path}`);
      }
    }
  }

  if (searchIndex) {
    if (searchIndex.byteLength > SEARCH_RAW_BYTE_LIMIT) {
      violations.push(`api/search exceeds ${SEARCH_RAW_BYTE_LIMIT} raw bytes`);
    }
    if (gzipSync(searchIndex, { level: 9 }).byteLength > SEARCH_GZIP_BYTE_LIMIT) {
      violations.push(`api/search exceeds ${SEARCH_GZIP_BYTE_LIMIT} gzip bytes`);
    }
    try {
      JSON.parse(searchIndex.toString('utf8'));
    } catch {
      violations.push('api/search is not valid JSON');
    }
  }

  return violations;
}

export async function checkBuiltArtifacts(options: BuiltArtifactOptions): Promise<void> {
  const violations = await builtArtifactViolations(options);
  if (violations.length > 0) {
    throw new Error(`Built artifact contract failed:\n${violations.join('\n')}`);
  }
}

const entryPath = process.argv[1];
if (entryPath && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  await checkBuiltArtifacts({ siteOrigin: requireSiteUrl() });
  process.stdout.write(`Built artifacts: ${sitePages().length} routes verified\n`);
}
