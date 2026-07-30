// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { DOCS_PAGE_COUNT } from '../src/docs-page-count.js';
import { CONTENT_PAGES } from './content-manifest.js';

describe('content manifest', () => {
  it('matches the page count exposed by the client search interface', () => {
    expect(CONTENT_PAGES).toHaveLength(DOCS_PAGE_COUNT);
  });
});
