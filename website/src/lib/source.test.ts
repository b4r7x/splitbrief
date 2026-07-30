import { describe, expect, it } from 'vitest';
import { source } from './source.js';

describe('documentation source', () => {
  it('loads generated server collections at the /docs base URL', () => {
    const introduction = source.getPage(['getting-started', 'introduction']);

    expect(introduction).toMatchObject({
      path: 'getting-started/introduction.mdx',
      slugs: ['getting-started', 'introduction'],
      url: '/docs/getting-started/introduction',
      data: {
        title: 'Introduction',
      },
    });
  });
});
