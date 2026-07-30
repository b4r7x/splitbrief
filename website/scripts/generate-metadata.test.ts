// @vitest-environment node

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SitePage } from './pages.js';
import { generateMetadata, metadataFiles } from './generate-metadata.js';

const temporaryDirectories: string[] = [];
const TEST_PAGES: readonly SitePage[] = [
  { path: '/', kind: 'page' },
  { path: '/docs/start', kind: 'page' },
  { path: '/docs/start.md', kind: 'md-mirror' },
  { path: '/404', kind: 'metadata' },
  { path: '/api/search', kind: 'metadata' },
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('canonical metadata generation', () => {
  it('includes only public HTML pages in a deterministic sitemap', () => {
    const files = metadataFiles('https://splitbrief.example', TEST_PAGES);

    expect(files.sitemap).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        '  <url><loc>https://splitbrief.example/</loc></url>',
        '  <url><loc>https://splitbrief.example/docs/start</loc></url>',
        '</urlset>',
        '',
      ].join('\n'),
    );
    expect(files.robots).toBe(
      ['User-agent: *', 'Allow: /', 'Sitemap: https://splitbrief.example/sitemap.xml', ''].join(
        '\n',
      ),
    );
  });

  it('writes both files from the same page enumeration', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'splitbrief-metadata-'));
    temporaryDirectories.push(outputDirectory);

    const generated = await generateMetadata({
      outputDirectory,
      pages: TEST_PAGES,
      siteUrl: 'https://splitbrief.example/',
    });

    await expect(readFile(join(outputDirectory, 'sitemap.xml'), 'utf8')).resolves.toBe(
      generated.sitemap,
    );
    await expect(readFile(join(outputDirectory, 'robots.txt'), 'utf8')).resolves.toBe(
      generated.robots,
    );
  });

  it('fails before writing when the canonical origin is unavailable', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'splitbrief-metadata-'));
    temporaryDirectories.push(outputDirectory);

    await expect(
      generateMetadata({
        outputDirectory,
        pages: TEST_PAGES,
        siteUrl: '',
      }),
    ).rejects.toThrow(/SITE_URL is required/);
  });
});
