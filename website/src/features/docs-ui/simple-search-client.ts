import { create, load, search } from '@orama/orama';
import { createContentHighlighter, type SortedResult } from 'fumadocs-core/search';
import type { ExportedData } from 'fumadocs-core/search/server';

const SEARCH_RESULT_LIMIT = 16;

const SIMPLE_SEARCH_SCHEMA = {
  breadcrumbs: 'string[]',
  content: 'string',
  description: 'string',
  keywords: 'string',
  title: 'string',
  url: 'string',
} as const;

function createSearchDatabase() {
  return create({ schema: SIMPLE_SEARCH_SCHEMA });
}

type SearchDatabase = ReturnType<typeof createSearchDatabase>;

let databasePromise: Promise<SearchDatabase> | undefined;

async function fetchSearchDatabase(): Promise<SearchDatabase> {
  const response = await fetch('/api/search');
  if (!response.ok) {
    throw new Error(`Failed to fetch the search index: ${response.status} ${response.statusText}`);
  }

  const exportedData: ExportedData = await response.json();
  if (exportedData.type !== 'simple') {
    throw new Error(`Expected a simple search index, received "${exportedData.type}"`);
  }

  const database = createSearchDatabase();
  load(database, exportedData);
  return database;
}

function getSearchDatabase(): Promise<SearchDatabase> {
  databasePromise ??= fetchSearchDatabase().catch((error: unknown) => {
    databasePromise = undefined;
    throw error;
  });

  return databasePromise;
}

export async function searchSimpleIndex(query: string): Promise<SortedResult[]> {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) return [];

  const database = await getSearchDatabase();
  const highlighter = createContentHighlighter(trimmedQuery);
  const results = await search(database, {
    boost: { title: 2 },
    limit: SEARCH_RESULT_LIMIT,
    term: trimmedQuery,
    tolerance: 1,
  });

  return results.hits.map((hit) => ({
    breadcrumbs: hit.document.breadcrumbs,
    content: highlighter.highlightMarkdown(hit.document.title),
    id: hit.document.url,
    type: 'page',
    url: hit.document.url,
  }));
}
