// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { source } from '../src/lib/source.js';
import { prerenderPages, sitePages } from './pages.js';

function withContentDirectory(run: (contentDirectory: string) => void): void {
  const contentDirectory = mkdtempSync(join(tmpdir(), 'splitbrief-pages-'));

  try {
    run(contentDirectory);
  } finally {
    rmSync(contentDirectory, { recursive: true, force: true });
  }
}

describe('site page enumeration', () => {
  it('keeps fixed surfaces before a content directory exists', () => {
    withContentDirectory((contentDirectory) => {
      expect(sitePages(join(contentDirectory, 'missing'))).toEqual([
        { path: '/', kind: 'page' },
        { path: '/404', kind: 'metadata', prerender: { outputPath: '/404.html' } },
        { path: '/og', kind: 'metadata' },
        { path: '/api/search', kind: 'metadata' },
        { path: '/llms.txt', kind: 'metadata' },
        { path: '/llms-full.txt', kind: 'metadata' },
      ]);
    });
  });

  it('normalizes index files and emits stable page, mirror, and prerender order', () => {
    withContentDirectory((contentDirectory) => {
      mkdirSync(join(contentDirectory, 'concepts'), { recursive: true });
      mkdirSync(join(contentDirectory, 'getting-started'), { recursive: true });
      mkdirSync(join(contentDirectory, 'guides'), { recursive: true });
      writeFileSync(join(contentDirectory, 'guides', 'cookbook.mdx'), '');
      writeFileSync(join(contentDirectory, 'getting-started', 'introduction.mdx'), '');
      writeFileSync(join(contentDirectory, 'concepts', 'task-briefs.mdx'), '');
      writeFileSync(join(contentDirectory, 'concepts', 'index.mdx'), '');
      writeFileSync(join(contentDirectory, 'guides', 'meta.json'), '{}');
      writeFileSync(join(contentDirectory, 'README.md'), '');

      const pages = sitePages(contentDirectory);
      const paths = pages.map((page) => page.path);

      expect(pages).toEqual([
        { path: '/', kind: 'page' },
        { path: '/404', kind: 'metadata', prerender: { outputPath: '/404.html' } },
        { path: '/og', kind: 'metadata' },
        { path: '/api/search', kind: 'metadata' },
        { path: '/llms.txt', kind: 'metadata' },
        { path: '/llms-full.txt', kind: 'metadata' },
        { path: '/docs/concepts', kind: 'page' },
        { path: '/docs/concepts.md', kind: 'md-mirror' },
        { path: '/docs/concepts/task-briefs', kind: 'page' },
        { path: '/docs/concepts/task-briefs.md', kind: 'md-mirror' },
        { path: '/docs/getting-started/introduction', kind: 'page' },
        { path: '/docs/getting-started/introduction.md', kind: 'md-mirror' },
        { path: '/docs/guides/cookbook', kind: 'page' },
        { path: '/docs/guides/cookbook.md', kind: 'md-mirror' },
      ]);
      expect(new Set(paths).size).toBe(paths.length);
      expect(paths).not.toContain('/docs');
      expect(prerenderPages(contentDirectory)).toEqual([
        { path: '/' },
        { path: '/404', prerender: { outputPath: '/404.html' } },
        { path: '/og' },
        { path: '/api/search' },
        { path: '/llms.txt' },
        { path: '/llms-full.txt' },
        { path: '/docs/concepts' },
        { path: '/docs/concepts.md' },
        { path: '/docs/concepts/task-briefs' },
        { path: '/docs/concepts/task-briefs.md' },
        { path: '/docs/getting-started/introduction' },
        { path: '/docs/getting-started/introduction.md' },
        { path: '/docs/guides/cookbook' },
        { path: '/docs/guides/cookbook.md' },
      ]);
    });
  });

  it('stays in lockstep with the generated Fumadocs source', () => {
    const enumeratedUrls = sitePages()
      .filter((page) => page.kind === 'page' && page.path.startsWith('/docs/'))
      .map((page) => page.path)
      .sort();
    const sourceUrls = source
      .getPages()
      .map((page) => page.url)
      .sort();

    expect(enumeratedUrls).toEqual(sourceUrls);
  });

  it('keeps an index suffix when its normalized directory slug is already occupied', () => {
    withContentDirectory((contentDirectory) => {
      mkdirSync(join(contentDirectory, 'guides'), { recursive: true });
      writeFileSync(join(contentDirectory, 'guides.mdx'), '');
      writeFileSync(join(contentDirectory, 'guides', 'index.mdx'), '');

      expect(
        sitePages(contentDirectory)
          .filter((page) => page.path.startsWith('/docs/'))
          .map((page) => page.path),
      ).toEqual(['/docs/guides', '/docs/guides.md', '/docs/guides/index', '/docs/guides/index.md']);
    });
  });

  it('rejects a root index that would claim the harness-owned docs redirect', () => {
    withContentDirectory((contentDirectory) => {
      writeFileSync(join(contentDirectory, 'index.mdx'), '');

      expect(() => sitePages(contentDirectory)).toThrow(
        'content/docs/index.mdx would collide with the reserved /docs redirect',
      );
    });
  });
});
