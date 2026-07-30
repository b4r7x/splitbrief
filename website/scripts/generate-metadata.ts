import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sitePages, type SitePage } from './pages.js';
import { PUBLIC_PATH, requireSiteUrl, SITE_URL } from './site.js';

interface MetadataFiles {
  readonly robots: string;
  readonly sitemap: string;
}

interface GenerateMetadataOptions {
  readonly outputDirectory?: string;
  readonly pages?: readonly SitePage[];
  readonly siteUrl?: string;
}

function sitemapEntry(siteUrl: string, path: string): string {
  const location = new URL(path, `${siteUrl}/`).href
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `  <url><loc>${location}</loc></url>`;
}

export function metadataFiles(
  siteUrl: string,
  pages: readonly SitePage[] = sitePages(),
): MetadataFiles {
  const canonicalOrigin = requireSiteUrl(siteUrl);
  const publicPagePaths = pages
    .filter((page) => page.kind === 'page')
    .map((page) => page.path)
    .sort((left, right) => left.localeCompare(right));

  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...publicPagePaths.map((path) => sitemapEntry(canonicalOrigin, path)),
    '</urlset>',
    '',
  ].join('\n');
  const robots = ['User-agent: *', 'Allow: /', `Sitemap: ${canonicalOrigin}/sitemap.xml`, ''].join(
    '\n',
  );

  return { robots, sitemap };
}

export async function generateMetadata({
  outputDirectory = PUBLIC_PATH,
  pages = sitePages(),
  siteUrl = SITE_URL,
}: GenerateMetadataOptions = {}): Promise<MetadataFiles> {
  const canonicalOrigin = requireSiteUrl(siteUrl);
  const files = metadataFiles(canonicalOrigin, pages);

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDirectory, 'robots.txt'), files.robots),
    writeFile(resolve(outputDirectory, 'sitemap.xml'), files.sitemap),
  ]);

  return files;
}

const entryPath = process.argv[1];
if (entryPath && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  const files = await generateMetadata();
  const pageCount = [...files.sitemap.matchAll(/<url>/g)].length;
  process.stdout.write(`Metadata: ${pageCount} public routes\n`);
}
