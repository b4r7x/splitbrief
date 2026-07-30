import type { Node, Root } from 'fumadocs-core/page-tree';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { IMPLEMENTER_DOC_PATHS, PLANNER_DOC_PATHS } from '../../docs-roles.js';
import { source } from '../../lib/source.js';
import { createDocsNavigation, findDocsNeighbours } from './navigation.js';

const TASK_BRIEFS_PAGE = {
  type: 'page',
  name: 'Task Briefs',
  url: '/docs/concepts/task-briefs',
} satisfies Node;

const TREE = {
  name: 'Documentation',
  children: [
    { type: 'separator', name: 'Getting started' },
    {
      type: 'page',
      name: 'Introduction',
      url: '/docs/getting-started/introduction',
    },
    {
      type: 'folder',
      name: 'More',
      children: [
        {
          type: 'page',
          name: 'Choosing models',
          url: '/docs/getting-started/choosing-models',
        },
      ],
    },
    { type: 'separator', name: 'Concepts' },
    TASK_BRIEFS_PAGE,
    { type: 'separator', name: 'Guides' },
    {
      type: 'page',
      name: 'Repo-map',
      url: '/docs/guides/repo-map',
    },
  ],
} satisfies Root;

describe('createDocsNavigation', () => {
  it('produces only JSON-safe navigation fields and assigns the frozen role map', () => {
    const groups = createDocsNavigation(TREE);

    expect(groups).toEqual([
      {
        label: 'Getting started',
        pages: [
          {
            href: '/docs/getting-started/introduction',
            role: 'neutral',
            title: 'Introduction',
          },
          {
            href: '/docs/getting-started/choosing-models',
            role: 'implementer',
            title: 'Choosing models',
          },
        ],
      },
      {
        label: 'Concepts',
        pages: [
          {
            href: '/docs/concepts/task-briefs',
            role: 'planner',
            title: 'Task Briefs',
          },
        ],
      },
      {
        label: 'Guides',
        pages: [
          {
            href: '/docs/guides/repo-map',
            role: 'implementer',
            title: 'Repo-map',
          },
        ],
      },
    ]);
    expect(JSON.parse(JSON.stringify(groups))).toEqual(groups);
  });

  it('keeps the exact frozen role memberships across all 32 generated pages', () => {
    const navigation = createDocsNavigation(source.getPageTree());
    const pages = navigation.flatMap((group) => group.pages);

    expect(PLANNER_DOC_PATHS).toEqual([
      '/docs/concepts/task-briefs',
      '/docs/concepts/workflow-modes-and-phases',
      '/docs/guides/planners-and-implementers',
    ]);
    expect(IMPLEMENTER_DOC_PATHS).toEqual([
      '/docs/getting-started/choosing-models',
      '/docs/guides/headless-and-ci',
      '/docs/guides/repo-map',
    ]);
    expect(pages).toHaveLength(32);
    expect(pages.filter((page) => page.role === 'planner').map((page) => page.href)).toEqual(
      PLANNER_DOC_PATHS,
    );
    expect(pages.filter((page) => page.role === 'implementer').map((page) => page.href)).toEqual(
      IMPLEMENTER_DOC_PATHS,
    );
    expect(pages.filter((page) => page.role === 'neutral')).toHaveLength(26);
    expect(JSON.parse(JSON.stringify(navigation))).toEqual(navigation);
  });

  it('rejects React nodes before they cross the server-function boundary', () => {
    const tree = {
      name: 'Documentation',
      children: [
        { type: 'separator', name: 'Concepts' },
        {
          type: 'page',
          name: createElement('code', null, 'Task Briefs'),
          url: '/docs/concepts/task-briefs',
        },
      ],
    } satisfies Root;

    expect(() => createDocsNavigation(tree)).toThrow(
      'Page title for /docs/concepts/task-briefs must be a non-empty string',
    );
  });

  it('rejects duplicate URLs in the generated page tree', () => {
    const duplicateTree = {
      name: 'Documentation',
      children: [{ type: 'separator', name: 'Concepts' }, TASK_BRIEFS_PAGE, TASK_BRIEFS_PAGE],
    } satisfies Root;

    expect(() => createDocsNavigation(duplicateTree)).toThrow(
      'Duplicate documentation URL: /docs/concepts/task-briefs',
    );
  });
});

describe('findDocsNeighbours', () => {
  it('derives adjacent pages across group boundaries without undefined fields', () => {
    const groups = createDocsNavigation(TREE);

    expect(findDocsNeighbours(groups, '/docs/getting-started/choosing-models')).toEqual({
      previous: {
        href: '/docs/getting-started/introduction',
        title: 'Introduction',
      },
      next: {
        href: '/docs/concepts/task-briefs',
        title: 'Task Briefs',
      },
    });
    expect(findDocsNeighbours(groups, '/docs/getting-started/introduction')).toEqual({
      next: {
        href: '/docs/getting-started/choosing-models',
        title: 'Choosing models',
      },
    });
  });

  it('fails when a loaded page is hidden from the navigation contract', () => {
    expect(() => findDocsNeighbours(createDocsNavigation(TREE), '/docs/hidden')).toThrow(
      'Documentation page is missing from navigation: /docs/hidden',
    );
  });
});
