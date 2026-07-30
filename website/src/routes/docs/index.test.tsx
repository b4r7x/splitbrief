import { isRedirect } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { redirectToDocsHome } from './index.js';

describe('/docs redirect', () => {
  it('replaces the index URL with the first documentation page without a trailing slash', () => {
    try {
      redirectToDocsHome();
      throw new Error('Expected the docs index loader to redirect');
    } catch (error) {
      expect(isRedirect(error)).toBe(true);
      if (!isRedirect(error)) {
        return;
      }

      expect(error.options).toMatchObject({
        href: '/docs/getting-started/introduction',
        replace: true,
        statusCode: 301,
      });
      expect(error.options.href).not.toMatch(/\/$/);
    }
  });
});
