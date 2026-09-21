import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { guideLink, loadCatalog, repository } from './catalog.js';
import { renderGuide } from './markdown.js';

describe('repository documentation', () => {
  it('maps every Markdown source once, with one navigation entry per page', async () => {
    const { pages, groups } = await loadCatalog();
    const sources = (await readdir(`${repository}docs`, { recursive: true }))
      .filter((path) => path.endsWith('.md'))
      .map((path) => `docs/${path}`);
    expect(pages.map((page) => page.source).sort()).toEqual(
      [...sources, 'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md'].sort(),
    );
    expect(new Set(pages.map((page) => page.route)).size).toBe(pages.length);
    expect(
      [
        'docs/README.md',
        ...groups.flatMap((group) => group.pages.map((page) => page.source)),
      ].sort(),
    ).toEqual(pages.map((page) => page.source).sort());
  });

  it('resolves all internal article links and section anchors, including nested guides', async () => {
    const { pages } = await loadCatalog();
    const articles = pages.map((page) => ({ page, ...renderGuide(page, pages) }));
    const ids = new Map(
      articles.map(({ page, article }) => [
        page.route,
        new Set([...article.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])),
      ]),
    );
    for (const { page, article } of articles) {
      expect((article.match(/<h1\b/g) ?? []).length, page.source).toBe(1);
      for (const match of article.matchAll(/href="([^"]+)"/g)) {
        const url = new URL(
          (match[1] ?? '').replaceAll('&amp;', '&'),
          `https://site.test/prefix/${page.route}`,
        );
        if (url.origin !== 'https://site.test') continue;
        const targets = ids.get(url.pathname.replace('/prefix/', ''));
        expect(targets, `${page.source} → ${url}`).toBeDefined();
        if (url.hash)
          expect(
            targets?.has(decodeURIComponent(url.hash.slice(1))),
            `${page.source} → ${url.hash}`,
          ).toBe(true);
      }
    }
  });

  it('keeps unsafe URLs and raw HTML out while retaining code and explicit anchors', async () => {
    const { pages } = await loadCatalog();
    const original = pages.find((page) => page.source === 'docs/GETTING-STARTED.md');
    if (!original) throw new Error('Missing Getting started guide');
    const page = {
      ...original,
      markdown:
        '# Sample\n\n[bad](javascript:alert(1))\n\n<script>alert(1)</script>\n\n<a id="named-anchor"></a>\n\n```sh\nnpm install -g splitbrief\n```',
    };
    const { article } = renderGuide(page, pages);
    expect(article).not.toContain('javascript:');
    expect(article).not.toContain('<script');
    expect(article).toContain('id="named-anchor"');
    expect(article).toContain('<code>npm install -g splitbrief</code>');
    expect(guideLink('./CLI-REFERENCE.md#start', page, pages)).toBe('../cli-reference/#start');
    expect(guideLink('../src/cli.ts', page, pages)).toBe(
      'https://github.com/b4r7x/splitbrief/blob/main/src/cli.ts',
    );
  });
});
