import { describe, expect, it } from 'vitest';
import type { LLMPage } from './get-llm-text.js';
import { buildLLMsFullText, buildLLMsIndex } from './llms-text.js';

function page(title: string, url: string, markdown = `## ${title}`): LLMPage {
  return {
    url,
    data: {
      title,
      description: `${title} reference.`,
      getText: async () => markdown,
    },
  };
}

describe('buildLLMsIndex', () => {
  it('emits ordered absolute Markdown-mirror links within the 5 KiB contract', () => {
    const pages = [
      page('Introduction', '/docs/getting-started/introduction'),
      page('Task Briefs', '/docs/concepts/task-briefs'),
      page('CLI', '/docs/reference/cli'),
    ];

    const index = buildLLMsIndex(pages, 'https://docs.example.test');

    expect(index).toContain(
      '[Introduction](https://docs.example.test/docs/getting-started/introduction.md)',
    );
    expect(index).toContain(
      '[Task Briefs](https://docs.example.test/docs/concepts/task-briefs.md)',
    );
    expect(index).toContain('[CLI](https://docs.example.test/docs/reference/cli.md)');
    expect(index.indexOf('[Introduction]')).toBeLessThan(index.indexOf('[Task Briefs]'));
    expect(index.indexOf('[Task Briefs]')).toBeLessThan(index.indexOf('[CLI]'));
    expect(new TextEncoder().encode(index).byteLength).toBeLessThanOrEqual(5_120);
  });

  it('rejects an index that would silently exceed the 5 KiB contract', () => {
    const pages = Array.from({ length: 80 }, (_, index) =>
      page(`Documentation page ${index}`, `/docs/reference/documentation-page-${index}`),
    );

    expect(() => buildLLMsIndex(pages, 'https://docs.example.test')).toThrow(RangeError);
  });
});

describe('buildLLMsFullText', () => {
  it('joins processed pages in source order with visible document boundaries', async () => {
    const text = await buildLLMsFullText([
      page('First', '/docs/first', 'First body.'),
      page('Second', '/docs/second', 'Second body.'),
    ]);

    expect(text).toBe(`# First (/docs/first)

> First reference.

First body.

---

# Second (/docs/second)

> Second reference.

Second body.`);
  });
});
