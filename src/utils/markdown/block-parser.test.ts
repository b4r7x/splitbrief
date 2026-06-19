import { describe, expect, it } from 'vitest';
import { parseMarkdownBlocks } from './block-parser.js';

describe('parseMarkdownBlocks', () => {
  it('keeps markdown-looking lines inside a fence as code', () => {
    const document = parseMarkdownBlocks(['```md', '# heading', '---', '- item', '```'].join('\n'));

    expect(document.blocks).toEqual([
      {
        kind: 'code',
        language: 'md',
        lines: ['# heading', '---', '- item'],
      },
    ]);
  });

  it('parses frontmatter at the beginning as metadata', () => {
    const document = parseMarkdownBlocks(
      ['---', 'title: Markdown core', 'owner: docs', '---', '# Markdown core'].join('\n'),
    );

    expect(document.blocks).toEqual([
      {
        kind: 'frontmatter',
        lines: ['title: Markdown core', 'owner: docs'],
      },
      {
        kind: 'heading',
        depth: 1,
        text: 'Markdown core',
        inlines: [{ kind: 'text', text: 'Markdown core' }],
      },
    ]);
  });

  it('parses task brief metadata blocks after ordinary content', () => {
    const document = parseMarkdownBlocks(
      [
        'Planner notes',
        '',
        '---',
        'id: T001',
        'title: Add parser test',
        'action: modify',
        'file: src/utils/markdown/block-parser.ts',
        'depends_on: []',
        '---',
        '### Description',
        'First task.',
        '',
        '---',
        '',
        'Between tasks',
        '',
        '---',
        'id: T002',
        'title: Add workflow row test',
        'action: modify',
        'file: src/features/workflow/conversation-rows/markdown-rows.test.ts',
        'depends_on:',
        '  - T001',
        '---',
        '### Description',
        'Second task.',
      ].join('\n'),
    );
    const frontmatterBlocks = document.blocks.filter((block) => block.kind === 'frontmatter');

    expect(document.blocks.map((block) => block.kind)).toEqual([
      'paragraph',
      'frontmatter',
      'heading',
      'paragraph',
      'thematicBreak',
      'paragraph',
      'frontmatter',
      'heading',
      'paragraph',
    ]);
    expect(frontmatterBlocks).toEqual([
      {
        kind: 'frontmatter',
        lines: [
          'id: T001',
          'title: Add parser test',
          'action: modify',
          'file: src/utils/markdown/block-parser.ts',
          'depends_on: []',
        ],
      },
      {
        kind: 'frontmatter',
        lines: [
          'id: T002',
          'title: Add workflow row test',
          'action: modify',
          'file: src/features/workflow/conversation-rows/markdown-rows.test.ts',
          'depends_on:',
          '  - T001',
        ],
      },
    ]);
  });

  it('parses bare task brief metadata as bounded blocks', () => {
    const document = parseMarkdownBlocks(
      [
        'id: T001',
        'title: Add parser test',
        'action: modify',
        'file: src/utils/markdown/block-parser.ts',
        'depends_on:',
        '  - T001',
        '---',
        '### Description',
        'First task.',
        '',
        'id: T002',
        'title: Add workflow row test',
        'action: modify',
        'file: src/features/workflow/conversation-rows/markdown-rows.test.ts',
        'depends_on: []',
        '---',
        '### Description',
        'Second task.',
      ].join('\n'),
    );

    expect(document.blocks.map((block) => block.kind)).toEqual([
      'frontmatter',
      'heading',
      'paragraph',
      'frontmatter',
      'heading',
      'paragraph',
    ]);
    expect(document.blocks.filter((block) => block.kind === 'thematicBreak')).toEqual([]);
  });

  it('preserves list indentation for nested-ish ordered and unordered items', () => {
    const document = parseMarkdownBlocks(
      ['- parent', '  - child', '  1. ordered', '2. top-level'].join('\n'),
    );

    expect(document.blocks).toMatchObject([
      {
        kind: 'list',
        items: [
          { kind: 'unordered', indent: 0, text: 'parent' },
          { kind: 'unordered', indent: 2, text: 'child' },
          { kind: 'ordered', indent: 2, marker: '1.', start: 1, text: 'ordered' },
          { kind: 'ordered', indent: 0, marker: '2.', start: 2, text: 'top-level' },
        ],
      },
    ]);
  });

  it('strips terminal controls before parsing markdown text', () => {
    const document = parseMarkdownBlocks(
      '# Safe\u001b[31m heading\u001b[0m\u0007\n\u001b]52;c;clipboard\u0007visible',
    );

    expect(document.blocks).toMatchObject([
      {
        kind: 'heading',
        text: 'Safe heading',
      },
      {
        kind: 'paragraph',
        text: 'visible',
      },
    ]);
    expect(JSON.stringify(document)).not.toContain('clipboard');
  });

  it('parses deeply nested quote markers without exhausting the call stack', () => {
    const compactMarkers = `${'>'.repeat(5000)} safe`;
    const spacedMarkers = `${Array.from({ length: 5000 }, () => '>').join(' ')} safe`;

    expect(() => parseMarkdownBlocks(compactMarkers)).not.toThrow();
    expect(() => parseMarkdownBlocks(spacedMarkers)).not.toThrow();
  });
});
