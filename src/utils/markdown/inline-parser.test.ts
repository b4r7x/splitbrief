import { describe, expect, it } from 'vitest';
import { parseMarkdownInlines } from './inline-parser.js';

describe('parseMarkdownInlines', () => {
  it('gives inline code precedence over emphasis', () => {
    const tokens = parseMarkdownInlines('Use `**literal**` before **bold** and *italic*');

    expect(tokens).toEqual([
      { kind: 'text', text: 'Use ' },
      { kind: 'code', text: '**literal**' },
      { kind: 'text', text: ' before ' },
      { kind: 'bold', text: 'bold' },
      { kind: 'text', text: ' and ' },
      { kind: 'italic', text: 'italic' },
    ]);
  });

  it('leaves paths and uppercase words as plain markdown text', () => {
    const tokens = parseMarkdownInlines('Read src/utils/markdown/layout.ts before RELEASE NOTES');

    expect(tokens).toEqual([
      {
        kind: 'text',
        text: 'Read src/utils/markdown/layout.ts before RELEASE NOTES',
      },
    ]);
  });

  it('supports bold italic spans when the delimiter is unambiguous', () => {
    expect(parseMarkdownInlines('Ship ***carefully***')).toEqual([
      { kind: 'text', text: 'Ship ' },
      { kind: 'boldItalic', text: 'carefully' },
    ]);
  });
});
