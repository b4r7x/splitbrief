import { posix } from 'node:path';
import { DOCS_CONTENT_DIRECTORY, findFiles, relativeFileStem } from './content-files.js';

type PageKind = 'page' | 'md-mirror' | 'metadata';

export interface SitePage {
  path: string;
  kind: PageKind;
  prerender?: {
    outputPath: string;
  };
}

type PrerenderPage = Omit<SitePage, 'kind'>;

const ROOT_PAGES: readonly SitePage[] = [
  { path: '/', kind: 'page' },
  { path: '/404', kind: 'metadata', prerender: { outputPath: '/404.html' } },
  { path: '/og', kind: 'metadata' },
  { path: '/api/search', kind: 'metadata' },
  { path: '/llms.txt', kind: 'metadata' },
  { path: '/llms-full.txt', kind: 'metadata' },
];

function mdxSlugs(directory: string): string[] {
  const paths = findFiles({ directory, extension: '.mdx' }).map((file) => {
    return relativeFileStem({ directory, file });
  });
  const nonIndexSlugs = new Set(
    paths.filter((path) => posix.basename(path) !== 'index').map((path) => path),
  );

  return paths
    .map((path) => {
      if (posix.basename(path) !== 'index') {
        return path;
      }

      const directorySlug = posix.dirname(path);
      if (directorySlug === '.') {
        throw new Error('content/docs/index.mdx would collide with the reserved /docs redirect');
      }

      return nonIndexSlugs.has(directorySlug) ? `${directorySlug}/index` : directorySlug;
    })
    .sort();
}

function documentationPages(contentDirectory: string): SitePage[] {
  return mdxSlugs(contentDirectory).flatMap<SitePage>((slug) => {
    const path = `/docs/${slug}`;

    return [
      { path, kind: 'page' },
      { path: `${path}.md`, kind: 'md-mirror' },
    ];
  });
}

export function sitePages(contentDirectory = DOCS_CONTENT_DIRECTORY): SitePage[] {
  const pages = [...ROOT_PAGES, ...documentationPages(contentDirectory)];
  const paths = new Set<string>();

  for (const page of pages) {
    if (paths.has(page.path)) {
      throw new Error(`Duplicate site page path: ${page.path}`);
    }
    paths.add(page.path);
  }

  return pages;
}

export function prerenderPages(contentDirectory = DOCS_CONTENT_DIRECTORY): PrerenderPage[] {
  return sitePages(contentDirectory).map((page) => {
    if (page.prerender) {
      return { path: page.path, prerender: page.prerender };
    }

    return { path: page.path };
  });
}
