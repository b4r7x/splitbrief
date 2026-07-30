import type { Root } from 'fumadocs-core/page-tree';
import { initSimpleSearch } from 'fumadocs-core/search/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { createSimpleSearchIndexes, type SearchIndexPage } from './search-index.server.js';

const TREE = {
  name: 'Documentation',
  children: [
    { type: 'separator', name: 'Concepts' },
    {
      type: 'page',
      name: 'Task Briefs',
      url: '/docs/concepts/task-briefs',
    },
    { type: 'separator', name: 'Guides' },
    {
      type: 'page',
      name: 'Recovery',
      url: '/docs/guides/recovery',
    },
  ],
} satisfies Root;

function page({
  body,
  description,
  heading = 'Overview',
  title,
  url,
}: {
  readonly body: string;
  readonly description?: string;
  readonly heading?: string;
  readonly title: string;
  readonly url: string;
}): SearchIndexPage {
  return {
    data: {
      title,
      structuredData: {
        contents: [{ content: body, heading: 'overview' }],
        headings: [{ content: heading, id: 'overview' }],
      },
      ...(description === undefined ? {} : { description }),
    },
    url,
  };
}

describe('createSimpleSearchIndexes', () => {
  it('indexes one full page record with stable navigation breadcrumbs', () => {
    const pages = [
      page({
        body: '\n\nThe planner emits a reviewable contract.\n',
        description: 'A stable implementation contract.',
        title: 'Task Briefs',
        url: '/docs/concepts/task-briefs',
      }),
      page({
        body: 'Restore the last safe snapshot.',
        title: 'Recovery',
        url: '/docs/guides/recovery',
      }),
    ];

    expect(createSimpleSearchIndexes({ pages, tree: TREE })).toEqual([
      {
        breadcrumbs: ['Documentation', 'Concepts'],
        content: 'Overview\nThe planner emits a reviewable contract.',
        description: 'A stable implementation contract.',
        title: 'Task Briefs',
        url: '/docs/concepts/task-briefs',
      },
      {
        breadcrumbs: ['Documentation', 'Guides'],
        content: 'Overview\nRestore the last safe snapshot.',
        title: 'Recovery',
        url: '/docs/guides/recovery',
      },
    ]);
  });

  it('keeps title and full-body queries searchable as page results', async () => {
    const indexes = createSimpleSearchIndexes({
      pages: [
        page({
          body: 'The drift sentinel restores the last safe snapshot.',
          title: 'Approval and recovery',
          url: '/docs/guides/recovery',
        }),
      ],
      tree: {
        name: 'Documentation',
        children: [
          { type: 'separator', name: 'Guides' },
          {
            type: 'page',
            name: 'Approval and recovery',
            url: '/docs/guides/recovery',
          },
        ],
      },
    });
    const search = initSimpleSearch({ indexes });

    await expect(search.search('Approval')).resolves.toMatchObject([
      {
        breadcrumbs: ['Documentation', 'Guides'],
        content: '<mark>Approval</mark> and recovery',
        type: 'page',
        url: '/docs/guides/recovery',
      },
    ]);
    await expect(search.search('sentinel')).resolves.toMatchObject([
      {
        breadcrumbs: ['Documentation', 'Guides'],
        content: 'Approval and recovery',
        type: 'page',
        url: '/docs/guides/recovery',
      },
    ]);
  });

  it('rejects source pages that are absent from public navigation', () => {
    expect(() =>
      createSimpleSearchIndexes({
        pages: [
          page({
            body: 'Hidden',
            title: 'Hidden',
            url: '/docs/hidden',
          }),
        ],
        tree: TREE,
      }),
    ).toThrow('Documentation page is missing from navigation: /docs/hidden');
  });

  it('rejects a non-text documentation root breadcrumb', () => {
    expect(() =>
      createSimpleSearchIndexes({
        pages: [],
        tree: {
          name: createElement('span', null, 'Documentation'),
          children: [],
        },
      }),
    ).toThrow('Documentation root title must be a non-empty string');
  });
});
