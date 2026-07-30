import { describe, expect, it } from 'vitest';
import { getLLMText } from '../../lib/get-llm-text.js';
import { source } from '../../lib/source.js';
import { serveMarkdownMirror } from './{$}[.]md.js';

describe('Markdown mirror route', () => {
  it('serves a source page as UTF-8 Markdown', async () => {
    const page = source.getPages()[0];
    if (!page) {
      throw new Error('Expected at least one documentation page');
    }

    const response = await serveMarkdownMirror({
      params: { _splat: `${page.slugs.join('/')}.md` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    await expect(response.text()).resolves.toBe(await getLLMText(page));
  });

  it('returns a UTF-8 plain-text 404 for an unknown document', async () => {
    const response = await serveMarkdownMirror({
      params: { _splat: 'not-a-document.md' },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    await expect(response.text()).resolves.toBe('Document not found');
  });
});
