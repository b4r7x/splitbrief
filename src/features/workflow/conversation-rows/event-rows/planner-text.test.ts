import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../../stores/workflow/streaming-output.js';
import { getTerminalCellWidth } from '../../../../utils/display-text.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import { rowText } from '../row-format/rows.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

describe('planner text rows', () => {
  it.each([undefined, 'plain'] as const)(
    'keeps extracted-code output as dim plain text (%s)',
    (content) => {
      for (const text of [
        '# Load config\ndef __init__(self, *args):\n    self.args = args',
        '# Load config\nitems:\n- x\n1. value',
        '<!-- keep this comment -->\n<div>content</div>',
        '{"version":"file-bundle-v1","files":[{"path":"a.py","content":"`code` and *args"}]}',
      ]) {
        const rows = eventRows({
          event: {
            type: 'planner_text',
            ts: 0,
            phase: 'implementing',
            role: 'implementer',
            ...(content === undefined ? {} : { content }),
            text,
          },
          globalIndex: 0,
          expanded: false,
          ctx: { width: 160, viewportRows: 20, streaming },
        });

        expect(rows.map(rowText).join('\n')).toBe(text);
        for (const row of rows) {
          expect(row.codeBg).not.toBe(true);
          expect(row.segments).toEqual([{ text: rowText(row), tone: 'textDim', bold: false }]);
        }
      }
    },
  );

  it('renders marked implementer narration as dim markdown', () => {
    const rows = eventRows({
      event: {
        type: 'planner_text',
        ts: 0,
        phase: 'implementing',
        role: 'implementer',
        content: 'markdown',
        text: 'Implemented `lowStockItems` in [src/report.js](file:///tmp/trees/x/run/src/report.js).',
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const text = rows.map(rowText).join('\n');
    const segments = rows.flatMap((row) => row.segments);

    expect(text).toBe('Implemented lowStockItems in src/report.js.');
    expect(text).not.toContain('`');
    expect(text).not.toContain('](file:');
    expect(segments).toContainEqual({ text: 'lowStockItems', tone: 'markdownCode' });
    expect(segments).toContainEqual({
      text: 'src/report.js',
      tone: 'markdownLink',
      href: 'file:///tmp/trees/x/run/src/report.js',
    });
    expect(segments.filter((segment) => !segment.tone?.startsWith('markdown'))).toEqual([
      { text: 'Implemented ', tone: 'textDim' },
      { text: ' in ', tone: 'textDim' },
      { text: '.', tone: 'textDim' },
    ]);
  });

  it('replays unmarked hand-backs with plain dim narration and one report row', () => {
    const narration = 'Updated `a.ts` and [b.ts](file:///tmp/b.ts).';
    for (const [report, summary] of [
      [
        '{"status":"done","filesChanged":["a.ts","b.ts"],"touchedNotSuggested":[],"notes":null,"decisions":[]}',
        'Report  done · 2 files · 0 decisions',
      ],
      [
        '{"status":"blocked","question":"Where is the schema?","filesNeeded":["schema.ts"]}',
        'Report  blocked · 1 file needed',
      ],
    ] as const) {
      for (const text of [
        report,
        `${narration}\n\n${report}`,
        `${narration}\n\n\`\`\`json\n${report}\n\`\`\``,
      ]) {
        const rows = eventRows({
          event: { type: 'planner_text', ts: 0, phase: 'implementing', role: 'implementer', text },
          globalIndex: 0,
          expanded: false,
          ctx: { width: 160, viewportRows: 20, streaming },
        });
        expect(rows.map(rowText)).toEqual(text === report ? [summary] : [narration, summary]);
        for (const row of rows) {
          expect(row.codeBg).not.toBe(true);
          expect(row.segments).toEqual([{ text: rowText(row), tone: 'textDim', bold: false }]);
        }
      }
    }
  });

  it('styles marked hand-back narration and retains one report row', () => {
    const report = JSON.stringify({
      status: 'done',
      filesChanged: ['src/report.js'],
      touchedNotSuggested: [],
      notes: null,
      decisions: [{ what: 'kept the link target', why: 'opens the changed file' }],
    });
    for (const handBack of [report, ['```json', report, '```'].join('\n')]) {
      const rows = eventRows({
        event: {
          type: 'planner_text',
          ts: 0,
          phase: 'implementing',
          role: 'implementer',
          content: 'markdown',
          text: [
            'Implemented `lowStockItems` in [src/report.js](file:///tmp/trees/x/run/src/report.js).',
            '',
            handBack,
          ].join('\n'),
        },
        globalIndex: 0,
        expanded: false,
        ctx: { width: 80, viewportRows: 20, streaming },
      });
      const lines = rows.map(rowText);
      const text = lines.join('\n');
      const segments = rows.flatMap((row) => row.segments);

      expect(lines).toEqual([
        'Implemented lowStockItems in src/report.js.',
        'Report  done · 1 file · 1 decision',
      ]);
      expect(lines.filter((line) => line.startsWith('Report  '))).toHaveLength(1);
      expect(text).not.toContain('`');
      expect(text).not.toContain('](file:');
      expect(text).not.toContain('"status"');
      expect(text).not.toContain('filesChanged');
      expect(segments).toContainEqual({ text: 'lowStockItems', tone: 'markdownCode' });
      expect(segments).toContainEqual({
        text: 'src/report.js',
        tone: 'markdownLink',
        href: 'file:///tmp/trees/x/run/src/report.js',
      });
      expect(rows[0]?.segments[0]).toEqual({ text: 'Implemented ', tone: 'textDim' });
      expect(rows.at(-1)?.segments).toContainEqual({
        text: 'Report  done · 1 file · 1 decision',
        tone: 'textDim',
        bold: false,
      });
    }
  });

  it('renders markdown planner documents without raw heading or fence markers', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'planning',
      content: 'markdown',
      text: [
        'id: T001',
        'title: Run no-op validation smoke check',
        '---',
        '',
        '### Description',
        'Run a quick validation-only smoke check.',
        '',
        '### Signature',
        '```typescript',
        '// No exported signature.',
        '```',
      ].join('\n'),
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const text = rows.map(rowText).join('\n');
    const heading = rows.find((rowValue) => rowText(rowValue).includes('Description'));

    // No phase header: the artifact card already names Plan in this column.
    expect(rowText(rows[0] ?? { key: 'missing', kind: 'message', segments: [] })).toBe('id: T001');
    expect(rows[0]?.segments).toContainEqual({ text: 'T001', tone: 'text', bold: true });
    expect(text).toContain('Description');
    expect(text).toContain('// No exported signature.');
    expect(text).not.toContain('│');
    expect(text).not.toContain('###');
    expect(text).not.toContain('```typescript');
    expect(text).not.toContain('```');
    // Depth 3 carries the heading tone without bold, which is what separates it from depth 2.
    expect(heading?.segments).toContainEqual({ text: 'Description', tone: 'markdownHeading' });
  });

  it('strips a leading H1 heading from the planner’s first transcript block when it echoes the title', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'analyzing',
      content: 'markdown',
      text: '# Add dark-mode toggle\n\nLooking into the request now.',
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      dedupTitle: 'Add dark-mode toggle',
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const text = rows.map(rowText).join('\n');

    expect(text).not.toContain('Add dark-mode toggle');
    expect(text).toContain('Looking into the request now.');
  });

  it('keeps a leading H1 heading that does not echo the title', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'analyzing',
      content: 'markdown',
      text: '# Add dark-mode toggle\n\nLooking into the request now.',
    };

    const rows = eventRows({
      event,
      globalIndex: 1,
      expanded: false,
      dedupTitle: 'A completely different feature',
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain('Add dark-mode toggle');
  });

  it('strips terminal controls before wrapping planner rows', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'planning',
      role: 'planner',
      text: `abcd\u001b]52;c;${'x'.repeat(80)}\u0007efgh`,
    };

    const lines = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 5, viewportRows: 20, streaming },
    }).map(rowText);

    // Five columns past the row's three-cell leading leave a two-cell body: the payload the OSC 52
    // sequence carries never reaches it, so only `abcdefgh` is wrapped.
    expect(lines).toEqual(['ab', 'cd', 'ef', 'gh']);
    expect(lines.every((line) => getTerminalCellWidth(line) <= 2)).toBe(true);
  });

  it('renders the implementer’s trailing hand-back as one dim report row', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: [
        'Implemented the row.',
        '',
        '{"status":"done","filesChanged":["src/a.ts","src/b.ts"],"touchedNotSuggested":[{"file":"src/c.ts","reason":"the caller needs it"}],"notes":null,"decisions":[{"what":"added an export","why":"the caller needs it"}]}',
      ].join('\n'),
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const text = rows.map(rowText).join('\n');

    expect(rows.map(rowText)).toEqual([
      'Implemented the row.',
      'Report  done · 2 files · 1 decision',
    ]);
    expect(text).not.toContain('"status"');
    expect(text).not.toContain('filesChanged');
    expect(rows.at(-1)?.segments).toContainEqual({
      text: 'Report  done · 2 files · 1 decision',
      tone: 'textDim',
      bold: false,
    });
  });

  // In a real run, T005 fenced its report, and a bare ```json row stood above `Report  done`.
  it.each([
    ['```json', '```'],
    ['````json', '````'],
    ['```', '```'],
  ])('drops the %s fence around a hand-back with the report it wrapped', (open, close) => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: [
        'Implemented the row.',
        '',
        open,
        '{"status":"done","filesChanged":["src/a.ts"],"touchedNotSuggested":[],"notes":null,"decisions":[]}',
        close,
      ].join('\n'),
    };

    const lines = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    }).map(rowText);

    expect(lines).toEqual(['Implemented the row.', 'Report  done · 1 file · 0 decisions']);
  });

  it('renders a code block in narration before a bare report', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: [
        'The row reads:',
        '```ts',
        'row.render();',
        '```',
        '{"status":"done","filesChanged":["src/a.ts"],"touchedNotSuggested":[],"notes":null,"decisions":[]}',
      ].join('\n'),
    };

    const rows = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    });
    const text = rows.map(rowText).join('\n');

    expect(text).toContain('The row reads:');
    expect(text).toContain('row.render();');
    expect(text).not.toContain('```');
    expect(rows.some((row) => row.codeBg === true)).toBe(true);
    expect(rows.map(rowText).filter((line) => line.startsWith('Report  '))).toEqual([
      'Report  done · 1 file · 0 decisions',
    ]);
  });

  it('summarizes a blocked hand-back without its JSON', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: 'I need the schema file.\n\n{"status":"blocked","question":"Where is the schema?","filesNeeded":["src/schema.ts"]}',
    };

    const lines = eventRows({
      event,
      globalIndex: 1,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    }).map(rowText);

    expect(lines).toEqual(['I need the schema file.', 'Report  blocked · 1 file needed']);
  });

  it('leaves implementer text with no parseable trailing report unchanged', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: 'Still reading the call sites; nothing to report yet.',
    };

    const lines = eventRows({
      event,
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming },
    }).map(rowText);

    expect(lines).toEqual(['Still reading the call sites; nothing to report yet.']);
  });
});
