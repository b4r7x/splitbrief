import '@tanstack/react-start/server-only';
import type { StructuredData } from 'fumadocs-core/mdx-plugins';
import type { Root } from 'fumadocs-core/page-tree';
import type { Index } from 'fumadocs-core/search/server';
import { docsTreeError } from './docs-tree-error.js';
import { createDocsNavigation } from './navigation.js';

export interface SearchIndexPage {
  readonly data: {
    readonly description?: string | undefined;
    readonly structuredData: StructuredData;
    readonly title: string;
  };
  readonly url: string;
}

interface SearchIndexInput {
  readonly pages: readonly SearchIndexPage[];
  readonly tree: Root;
}

function rootBreadcrumb(tree: Root): string {
  if (typeof tree.name !== 'string' || tree.name.trim().length === 0) {
    throw docsTreeError.invalidText('Documentation root title');
  }

  return tree.name;
}

function searchablePageContent({ contents, headings }: StructuredData): string {
  return [...headings, ...contents]
    .map((entry) => entry.content.trim())
    .filter((content) => content.length > 0)
    .join('\n');
}

export function createSimpleSearchIndexes({ pages, tree }: SearchIndexInput): Index[] {
  const root = rootBreadcrumb(tree);
  const breadcrumbsByUrl = new Map(
    createDocsNavigation(tree).flatMap((group) =>
      group.pages.map((page): [string, string[]] => [page.href, [root, group.label]]),
    ),
  );

  return pages.map((page) => {
    const breadcrumbs = breadcrumbsByUrl.get(page.url);
    if (!breadcrumbs) {
      throw docsTreeError.missingPage(page.url);
    }

    return {
      breadcrumbs,
      content: searchablePageContent(page.data.structuredData),
      title: page.data.title,
      url: page.url,
      ...(page.data.description === undefined ? {} : { description: page.data.description }),
    };
  });
}
