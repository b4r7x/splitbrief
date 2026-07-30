import { describe, expect, it } from 'vitest';
import { source } from '../lib/source.js';
import { llmsIndexResponse } from './llms[.]txt.js';

describe('llms.txt route', () => {
  it('serves every documentation mirror as an absolute link within 5 KiB', async () => {
    const pages = source.getPages();
    const response = llmsIndexResponse(pages, 'https://splitbrief.example');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(5_120);

    let previousPageOffset = -1;
    for (const page of pages) {
      const expectedLink = `[${page.data.title}](https://splitbrief.example${page.url}.md)`;
      const pageOffset = body.indexOf(expectedLink);
      expect(pageOffset).toBeGreaterThan(previousPageOffset);
      previousPageOffset = pageOffset;
    }
  });
});
