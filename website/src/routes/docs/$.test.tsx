import { isNotFound } from '@tanstack/react-router';
import { describe, expect, it, vi } from 'vitest';
import { resolveDocRoute } from '../../features/docs-ui/doc-route.server.js';

const serverBoundary = vi.hoisted(() => ({
  inputs: [] as unknown[],
  result: {
    currentPath: '/docs/concepts/task-briefs',
    description: 'The contract between the configured roles.',
    groups: [
      {
        label: 'Concepts',
        pages: [
          {
            href: '/docs/concepts/task-briefs',
            role: 'planner' as const,
            title: 'Task Briefs',
          },
        ],
      },
    ],
    path: 'concepts/task-briefs.mdx',
    title: 'Task Briefs',
  },
}));

const browserBoundary = vi.hoisted(() => ({
  preloadedPaths: [] as string[],
}));

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain = {
      validator: () => chain,
      handler:
        () =>
        async ({ data }: { data: unknown }) => {
          serverBoundary.inputs.push(data);
          return serverBoundary.result;
        },
    };
    return chain;
  },
}));

vi.mock('collections/browser', () => ({
  default: {
    docs: {
      createClientLoader: () => ({
        preload: async (path: string) => {
          browserBoundary.preloadedPaths.push(path);
        },
        useContent: () => null,
      }),
    },
  },
}));

import { docsHead, loadDocsRoute, parseDocPath } from './$.js';

describe('/docs/$ route loader', () => {
  it('splits path segments and waits for the exact MDX client chunk', async () => {
    serverBoundary.inputs.length = 0;
    browserBoundary.preloadedPaths.length = 0;

    const result = await loadDocsRoute('concepts/task-briefs');

    expect(serverBoundary.inputs).toEqual([{ slugs: ['concepts', 'task-briefs'] }]);
    expect(browserBoundary.preloadedPaths).toEqual(['concepts/task-briefs.mdx']);
    expect(result).toBe(serverBoundary.result);
  });

  it('validates non-empty path segments at the server-function boundary', () => {
    expect(parseDocPath({ slugs: ['concepts', 'task-briefs'] })).toEqual({
      slugs: ['concepts', 'task-briefs'],
    });
    for (const invalidPath of [
      undefined,
      null,
      {},
      { slugs: 'concepts/task-briefs' },
      { slugs: [] },
      { slugs: [''] },
      { slugs: ['concepts', 1] },
    ]) {
      expect(() => parseDocPath(invalidPath)).toThrow(TypeError);
    }
  });

  it('raises the router not-found signal when the document does not exist', () => {
    try {
      resolveDocRoute({ slugs: ['missing-document'] });
      throw new Error('Expected the missing document to raise notFound');
    } catch (error) {
      expect(isNotFound(error)).toBe(true);
    }
  });

  it('derives page metadata from serializable loader data', () => {
    expect(docsHead(serverBoundary.result)).toEqual({
      links: [],
      meta: [
        { title: 'Task Briefs — SPLITBRIEF docs' },
        {
          name: 'description',
          content: 'The contract between the configured roles.',
        },
      ],
    });
  });

  it('adds canonical and social metadata when the production origin is available', () => {
    const head = docsHead(serverBoundary.result, 'https://splitbrief.example');

    expect(head.links).toEqual([
      {
        rel: 'canonical',
        href: 'https://splitbrief.example/docs/concepts/task-briefs',
      },
    ]);
    expect(head.meta).toContainEqual({
      property: 'og:title',
      content: 'Task Briefs — SPLITBRIEF docs',
    });
    expect(head.meta).toContainEqual({
      property: 'og:image',
      content: 'https://splitbrief.example/og.png',
    });
  });
});
