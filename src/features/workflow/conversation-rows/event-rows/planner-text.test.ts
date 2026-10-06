import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../../../engine/events/types.js';
import type { StreamingOutputState } from '../../../../stores/workflow/streaming-output.js';
import { getTerminalCellWidth } from '../../../../utils/display-text.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import { rowText } from '../row-format/rows.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };

describe('planner text rows', () => {
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

  it('summarizes a blocked hand-back without its JSON', () => {
    const event: EngineEvent = {
      type: 'planner_text',
      ts: 0,
      phase: 'implementing',
      role: 'implementer',
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
