import { describe, expect, it } from 'vitest';
import { source } from '../lib/source.js';
import { serveLLMsFullText } from './llms-full[.]txt.js';

describe('llms-full.txt route', () => {
  it('serves every processed page in source order as UTF-8 plain text', async () => {
    const pages = source.getPages();
    const response = await serveLLMsFullText();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');

    let previousPageOffset = -1;
    for (const page of pages) {
      const pageOffset = body.indexOf(`# ${page.data.title} (${page.url})`);
      expect(pageOffset).toBeGreaterThan(previousPageOffset);
      previousPageOffset = pageOffset;
    }

    expect(body.match(/\n\n---\n\n/g)).toHaveLength(pages.length - 1);
  });
});
