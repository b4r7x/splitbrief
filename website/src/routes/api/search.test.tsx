import { describe, expect, it, vi } from 'vitest';
import { getStaticSearchIndex, Route } from './search.js';

const searchRouteMocks = vi.hoisted(() => ({
  createSimpleSearchIndexes: vi.fn(),
  pages: [{ url: '/docs/introduction' }],
  tree: { name: 'Documentation' },
  staticGET: vi.fn(),
}));

const createSearchAPI = vi.hoisted(() =>
  vi.fn((_type: string, _options: { indexes: () => unknown }) => ({
    staticGET: searchRouteMocks.staticGET,
  })),
);

vi.mock('../../lib/source.js', () => ({
  source: {
    getPages: () => searchRouteMocks.pages,
    getPageTree: () => searchRouteMocks.tree,
  },
}));

vi.mock('../../features/docs-ui/search-index.server.js', () => ({
  createSimpleSearchIndexes: searchRouteMocks.createSimpleSearchIndexes,
}));

vi.mock('fumadocs-core/search/server', () => ({
  createSearchAPI,
}));

describe('/api/search', () => {
  it('exports a page-level static Orama index through the server route', async () => {
    const expected = new Response('{"type":"simple"}', {
      headers: { 'Content-Type': 'application/json' },
    });
    searchRouteMocks.staticGET.mockResolvedValue(expected);
    searchRouteMocks.createSimpleSearchIndexes.mockResolvedValue([{ title: 'Introduction' }]);

    const actual = await getStaticSearchIndex();
    const options = createSearchAPI.mock.calls[0]?.[1];

    expect(createSearchAPI).toHaveBeenCalledOnce();
    expect(createSearchAPI).toHaveBeenCalledWith('simple', {
      indexes: expect.any(Function),
    });
    await expect(options?.indexes()).resolves.toEqual([{ title: 'Introduction' }]);
    expect(searchRouteMocks.createSimpleSearchIndexes).toHaveBeenCalledWith({
      pages: searchRouteMocks.pages,
      tree: searchRouteMocks.tree,
    });
    expect(searchRouteMocks.staticGET).toHaveBeenCalledOnce();
    expect(actual).toBe(expected);
    expect(Route.options.server).toEqual({
      handlers: { GET: getStaticSearchIndex },
    });
  });
});
