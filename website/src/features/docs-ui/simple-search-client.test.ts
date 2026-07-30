import { initSimpleSearch, type Index } from 'fumadocs-core/search/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const INDEXES = [
  {
    breadcrumbs: ['Documentation', 'Reference'],
    content: 'Set tokenBudget in splitbrief.config.ts to control planner spend.',
    description: 'Commands and configuration',
    title: 'CLI reference',
    url: '/docs/reference/cli',
  },
  {
    breadcrumbs: ['Documentation', 'Concepts'],
    content: 'Recovery resumes a paused run from the latest durable checkpoint.',
    title: 'Approval escalation and recovery',
    url: '/docs/concepts/approval-escalation-and-recovery',
  },
] satisfies Index[];

async function exportSimpleIndex(): Promise<unknown> {
  return initSimpleSearch({ indexes: INDEXES }).export();
}

async function importSearchClient() {
  vi.resetModules();
  return import('./simple-search-client.js');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchSimpleIndex', () => {
  it('loads once and finds both page titles and full page content', async () => {
    const exportedIndex = await exportSimpleIndex();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(exportedIndex), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { searchSimpleIndex } = await importSearchClient();

    await expect(searchSimpleIndex('CLI reference')).resolves.toEqual([
      {
        breadcrumbs: ['Documentation', 'Reference'],
        content: '<mark>CLI</mark> <mark>reference</mark>',
        id: '/docs/reference/cli',
        type: 'page',
        url: '/docs/reference/cli',
      },
    ]);
    await expect(searchSimpleIndex('tokenBudget')).resolves.toEqual([
      {
        breadcrumbs: ['Documentation', 'Reference'],
        content: 'CLI reference',
        id: '/docs/reference/cli',
        type: 'page',
        url: '/docs/reference/cli',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/search');
  });

  it('does not fetch for an empty query', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { searchSimpleIndex } = await importSearchClient();

    await expect(searchSimpleIndex('  ')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unexpected export format and retries on the next query', async () => {
    const exportedIndex = await exportSimpleIndex();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: {}, type: 'i18n' }))
      .mockResolvedValueOnce(Response.json(exportedIndex));
    vi.stubGlobal('fetch', fetchMock);
    const { searchSimpleIndex } = await importSearchClient();

    await expect(searchSimpleIndex('recovery')).rejects.toThrow(
      'Expected a simple search index, received "i18n"',
    );
    await expect(searchSimpleIndex('recovery')).resolves.toEqual([
      {
        breadcrumbs: ['Documentation', 'Concepts'],
        content: 'Approval escalation and <mark>recovery</mark>',
        id: '/docs/concepts/approval-escalation-and-recovery',
        type: 'page',
        url: '/docs/concepts/approval-escalation-and-recovery',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports an unsuccessful index response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 503, statusText: 'Unavailable' })),
    );
    const { searchSimpleIndex } = await importSearchClient();

    await expect(searchSimpleIndex('recovery')).rejects.toThrow(
      'Failed to fetch the search index: 503 Unavailable',
    );
  });
});
