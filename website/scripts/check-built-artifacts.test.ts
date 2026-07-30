// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SitePage } from './pages.js';
import { builtArtifactViolations, SEARCH_RAW_BYTE_LIMIT } from './check-built-artifacts.js';

const SITE_ORIGIN = 'https://splitbrief.example';
const temporaryDirectories: string[] = [];
const TEST_PAGES: readonly SitePage[] = [
  { path: '/', kind: 'page' },
  { path: '/404', kind: 'metadata', prerender: { outputPath: '/404.html' } },
  { path: '/og', kind: 'metadata' },
  { path: '/api/search', kind: 'metadata' },
  { path: '/llms.txt', kind: 'metadata' },
  { path: '/llms-full.txt', kind: 'metadata' },
  { path: '/docs/start', kind: 'page' },
  { path: '/docs/start.md', kind: 'md-mirror' },
];

async function writeFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'splitbrief-built-artifacts-'));
  temporaryDirectories.push(directory);
  await Promise.all([
    mkdir(join(directory, 'api'), { recursive: true }),
    mkdir(join(directory, 'docs', 'start'), { recursive: true }),
    mkdir(join(directory, 'og'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(directory, 'index.html'), '<h1>Home</h1>'),
    writeFile(join(directory, '404.html'), '<h1>Missing</h1>'),
    writeFile(join(directory, 'og', 'index.html'), '<h1>OG</h1>'),
    writeFile(join(directory, 'api', 'search'), '{"results":[]}'),
    writeFile(
      join(directory, 'llms.txt'),
      `# SPLITBRIEF\n\n- [Start](${SITE_ORIGIN}/docs/start.md)\n`,
    ),
    writeFile(join(directory, 'llms-full.txt'), '# SPLITBRIEF documentation\n'),
    writeFile(join(directory, 'docs', 'start', 'index.html'), '<h1>Start</h1>'),
    writeFile(join(directory, 'docs', 'start.md'), '# Start\n'),
    writeFile(join(directory, 'THIRD_PARTY_NOTICES.txt'), 'Third-party notices\n'),
    writeFile(
      join(directory, 'robots.txt'),
      `User-agent: *\nAllow: /\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
    ),
    writeFile(
      join(directory, 'sitemap.xml'),
      `<urlset><url><loc>${SITE_ORIGIN}/</loc></url><url><loc>${SITE_ORIGIN}/docs/start</loc></url></urlset>`,
    ),
    writeFile(join(directory, 'og.png'), Buffer.alloc(1_024, 1)),
  ]);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('built artifact contract', () => {
  it('accepts the complete static route, metadata, mirror, and search surface', async () => {
    const outputDirectory = await writeFixture();

    await expect(
      builtArtifactViolations({
        outputDirectory,
        pages: TEST_PAGES,
        siteOrigin: SITE_ORIGIN,
      }),
    ).resolves.toEqual([]);
  });

  it('reports missing routes, malformed metadata, and oversized search data together', async () => {
    const outputDirectory = await writeFixture();
    await Promise.all([
      writeFile(join(outputDirectory, 'llms.txt'), '# Missing mirrors\n'),
      writeFile(join(outputDirectory, 'robots.txt'), 'User-agent: *\n'),
      writeFile(join(outputDirectory, 'sitemap.xml'), '<urlset></urlset>'),
      writeFile(join(outputDirectory, 'api', 'search'), Buffer.alloc(SEARCH_RAW_BYTE_LIMIT + 1, 1)),
      rm(join(outputDirectory, 'docs', 'start.md')),
      rm(join(outputDirectory, 'THIRD_PARTY_NOTICES.txt')),
    ]);

    const violations = await builtArtifactViolations({
      outputDirectory,
      pages: TEST_PAGES,
      siteOrigin: SITE_ORIGIN,
    });

    expect(violations).toEqual(
      expect.arrayContaining([
        'docs/start.md is missing or unreadable',
        'THIRD_PARTY_NOTICES.txt is missing or unreadable',
        `llms.txt is missing ${SITE_ORIGIN}/docs/start.md`,
        `robots.txt is missing ${SITE_ORIGIN}/sitemap.xml`,
        `sitemap.xml is missing <loc>${SITE_ORIGIN}/</loc>`,
        `api/search exceeds ${SEARCH_RAW_BYTE_LIMIT} raw bytes`,
        'api/search is not valid JSON',
      ]),
    );
  });
});
