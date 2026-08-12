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
        role: 'document',
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
        role: 'task',
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
        role: 'task',
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

  describe('heading depths 4-6', () => {
    it.each([1, 2, 3, 4, 5, 6] as const)('emits a heading block for depth %d', (depth) => {
      const document = parseMarkdownBlocks(`${'#'.repeat(depth)} Title`);

      expect(document.blocks).toEqual([
        {
          kind: 'heading',
          depth,
          text: 'Title',
          inlines: [{ kind: 'text', text: 'Title' }],
        },
      ]);
    });

    it('keeps seven or more hashes as a paragraph', () => {
      const document = parseMarkdownBlocks('####### Too deep');

      expect(document.blocks).toMatchObject([{ kind: 'paragraph', text: '####### Too deep' }]);
    });
  });

  describe('table blocks', () => {
    it('parses a leading-pipe table with header, separator, and rows', () => {
      const document = parseMarkdownBlocks(
        ['| Name | Qty |', '| --- | ---: |', '| apple | 1 |', '| kiwi | 12 |'].join('\n'),
      );

      expect(document.blocks).toEqual([
        {
          kind: 'table',
          alignments: ['left', 'right'],
          header: [
            { text: 'Name', inlines: [{ kind: 'text', text: 'Name' }] },
            { text: 'Qty', inlines: [{ kind: 'text', text: 'Qty' }] },
          ],
          rows: [
            [
              { text: 'apple', inlines: [{ kind: 'text', text: 'apple' }] },
              { text: '1', inlines: [{ kind: 'text', text: '1' }] },
            ],
            [
              { text: 'kiwi', inlines: [{ kind: 'text', text: 'kiwi' }] },
              { text: '12', inlines: [{ kind: 'text', text: '12' }] },
            ],
          ],
        },
      ]);
    });

    it.each([
      ['| --- | --- |', ['left', 'left']],
      ['| :--- | --- |', ['left', 'left']],
      ['| :---: | --- |', ['center', 'left']],
      ['| ---: | --- |', ['right', 'left']],
      ['| :---: | ---: |', ['center', 'right']],
      ['|:---|:---:|', ['left', 'center']],
    ])('reads alignments from separator %s', (separator, alignments) => {
      const document = parseMarkdownBlocks(['| a | b |', separator, '| c | d |'].join('\n'));

      expect(document.blocks).toMatchObject([{ kind: 'table', alignments }]);
    });

    it('keeps mid-sentence pipes without a leading pipe as a paragraph', () => {
      const document = parseMarkdownBlocks(['a | b', '| --- |'].join('\n'));

      expect(document.blocks.map((block) => block.kind)).not.toContain('table');
    });

    it('keeps a table head without a separator line as a paragraph', () => {
      const document = parseMarkdownBlocks(['| a | b |', 'plain text'].join('\n'));

      expect(document.blocks).toMatchObject([{ kind: 'paragraph', text: '| a | b | plain text' }]);
    });

    it('keeps a trailing table head at end of input as a paragraph', () => {
      const document = parseMarkdownBlocks('| a | b |');

      expect(document.blocks).toMatchObject([{ kind: 'paragraph', text: '| a | b |' }]);
    });

    it('unescapes escaped pipes inside cells', () => {
      const document = parseMarkdownBlocks(
        ['| left \\| right | c |', '| --- | --- |', '| a \\| b | d |'].join('\n'),
      );

      expect(document.blocks).toMatchObject([
        {
          kind: 'table',
          header: [{ text: 'left | right' }, { text: 'c' }],
          rows: [[{ text: 'a | b' }, { text: 'd' }]],
        },
      ]);
    });

    it('accepts rows without a trailing pipe and parses cell inlines', () => {
      const document = parseMarkdownBlocks(
        ['| Col | Note', '| --- | --- |', '| **x** | plain'].join('\n'),
      );

      expect(document.blocks).toMatchObject([
        {
          kind: 'table',
          header: [{ text: 'Col' }, { text: 'Note' }],
          rows: [[{ text: '**x**', inlines: [{ kind: 'bold', text: 'x' }] }, { text: 'plain' }]],
        },
      ]);
    });

    it('interrupts a paragraph when a table starts', () => {
      const document = parseMarkdownBlocks(
        ['prose line', '| a | b |', '| --- | --- |', '| c | d |'].join('\n'),
      );

      expect(document.blocks.map((block) => block.kind)).toEqual(['paragraph', 'table']);
    });

    it('ends the table at the first non-table line', () => {
      const document = parseMarkdownBlocks(['| a |', '| --- |', '| b |', 'after table'].join('\n'));

      expect(document.blocks.map((block) => block.kind)).toEqual(['table', 'paragraph']);
    });
  });

  describe('html comment blocks', () => {
    it.each([
      '<!-- note -->',
      '<!-- Q:{"id":"q1","question":"Which mode?"} -->',
      '  <!-- indented -->',
      '<!--no spaces-->',
    ])('parses %s into an htmlComment block', (line) => {
      const document = parseMarkdownBlocks(line);

      expect(document.blocks).toEqual([{ kind: 'htmlComment', lines: [line] }]);
    });

    it('re-parses text after the closing marker as ordinary content', () => {
      const document = parseMarkdownBlocks('<!-- c --> tail');

      expect(document.blocks).toEqual([
        { kind: 'htmlComment', lines: ['<!-- c -->'] },
        { kind: 'paragraph', text: 'tail', inlines: [{ kind: 'text', text: 'tail' }] },
      ]);
    });

    it('keeps text after a multi-line comment close visible', () => {
      const document = parseMarkdownBlocks(
        ['before', '<!-- a', 'b --> trailing after close', 'after'].join('\n'),
      );

      expect(document.blocks).toEqual([
        { kind: 'paragraph', text: 'before', inlines: [{ kind: 'text', text: 'before' }] },
        { kind: 'htmlComment', lines: ['<!-- a', 'b -->'] },
        {
          kind: 'paragraph',
          text: 'trailing after close after',
          inlines: [{ kind: 'text', text: 'trailing after close after' }],
        },
      ]);
    });

    it('consumes a multi-line comment through its closing line', () => {
      const document = parseMarkdownBlocks(['<!--', 'hidden body', '-->', 'visible'].join('\n'));

      expect(document.blocks).toEqual([
        { kind: 'htmlComment', lines: ['<!--', 'hidden body', '-->'] },
        { kind: 'paragraph', text: 'visible', inlines: [{ kind: 'text', text: 'visible' }] },
      ]);
    });

    it('consumes an unterminated comment to end of input', () => {
      const document = parseMarkdownBlocks(
        ['<!-- Q:{"id":"q1",', '"question":"still streaming'].join('\n'),
      );

      expect(document.blocks).toEqual([
        { kind: 'htmlComment', lines: ['<!-- Q:{"id":"q1",', '"question":"still streaming'] },
      ]);
    });

    it('interrupts a paragraph when a comment starts', () => {
      const document = parseMarkdownBlocks(['prose', '<!-- hidden -->', 'more'].join('\n'));

      expect(document.blocks.map((block) => block.kind)).toEqual([
        'paragraph',
        'htmlComment',
        'paragraph',
      ]);
    });

    it('parses comments nested inside blockquotes', () => {
      const document = parseMarkdownBlocks('> <!-- hidden -->');

      expect(document.blocks).toEqual([
        { kind: 'blockquote', blocks: [{ kind: 'htmlComment', lines: ['<!-- hidden -->'] }] },
      ]);
    });
  });
});
