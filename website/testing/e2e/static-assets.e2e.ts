import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import {
  SEARCH_GZIP_BYTE_LIMIT,
  SEARCH_RAW_BYTE_LIMIT,
} from '../../scripts/check-built-artifacts.js';
import { sitePages } from '../../scripts/pages.js';

test('serves the real metadata, mirrors, and search payload with their static contracts', async ({
  request,
}) => {
  const [llms, mirror, robots, search, sitemap] = await Promise.all([
    request.get('/llms.txt'),
    request.get('/docs/getting-started/introduction.md'),
    request.get('/robots.txt'),
    request.get('/api/search'),
    request.get('/sitemap.xml'),
  ]);

  for (const response of [llms, mirror, robots, search, sitemap]) {
    expect(response.status()).toBe(200);
  }
  expect(llms.headers()['content-type']).toContain('text/plain');
  expect(mirror.headers()['content-type']).toContain('text/markdown');
  expect(robots.headers()['content-type']).toContain('text/plain');
  expect(search.headers()['content-type']).toContain('application/json');
  expect(sitemap.headers()['content-type']).toContain('application/xml');

  const sitemapText = await sitemap.text();
  const sitemapLocations = [...sitemapText.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => match[1] ?? '',
  );
  const siteOrigin = new URL(sitemapLocations[0] ?? '').origin;
  const expectedLocations = sitePages()
    .filter((page) => page.kind === 'page')
    .map((page) => new URL(page.path, `${siteOrigin}/`).href)
    .sort();
  expect(sitemapLocations.sort()).toEqual(expectedLocations);
  expect(await robots.text()).toContain(`Sitemap: ${siteOrigin}/sitemap.xml`);

  const llmsText = await llms.text();
  for (const page of sitePages().filter(
    (candidate) => candidate.kind === 'page' && candidate.path.startsWith('/docs/'),
  )) {
    expect(llmsText).toContain(`](${siteOrigin}${page.path}.md)`);
  }
  expect(await mirror.text()).toContain('SPLITBRIEF');

  const searchBody = await search.body();
  expect(searchBody.byteLength).toBeLessThanOrEqual(SEARCH_RAW_BYTE_LIMIT);
  expect(gzipSync(searchBody, { level: 9 }).byteLength).toBeLessThanOrEqual(SEARCH_GZIP_BYTE_LIMIT);
  const exportedSearchIndex: unknown = JSON.parse(searchBody.toString('utf8'));
  expect(exportedSearchIndex).toMatchObject({
    type: 'simple',
  });
  expect(exportedSearchIndex).toEqual(
    expect.objectContaining({
      docs: expect.anything(),
      index: expect.anything(),
      internalDocumentIDStore: expect.anything(),
      language: expect.anything(),
      pinning: expect.anything(),
      sorting: expect.anything(),
    }),
  );
});
