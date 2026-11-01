import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import { glyph } from '../../../lib/glyphs.js';
import { makeTaskStart } from '#testing/helpers/events/task.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import { renderFeature } from '#testing/helpers/ink.js';
import type { StreamingOutputState } from '../../../stores/workflow/streaming-output.js';
import { ConversationRowView } from '../components/conversation-flow/row-view.js';
import { wrapWidthFor } from './row-markers.js';

const streaming: StreamingOutputState = { taskId: null, lines: [], active: false };
const LIVE_MARK = glyph('statusInProgress');
const DONE_MARK = glyph('stageDone');

describe('taskStartedRowBlock markers', () => {
  it('a wrapped task_started block renders the status marker on its first line only', () => {
    const rows = eventRows({
      event: makeTaskStart({
        ts: 0,
        taskId: taskId('T001'),
        title: 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet',
        total: 1,
        file: 'z.ts',
        action: 'modify',
        tool: 'codex',
        implementerProfile: 'cheap',
        contextFit: 'fits',
        estimatedTokens: 100,
        contextLength: 32_768,
        routingReason: 'cheap',
      }),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 22, viewportRows: 20, streaming },
    });

    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]?.headerContinuation).not.toBe(true);
    for (const row of rows.slice(1)) {
      expect(row.headerContinuation).toBe(true);
      expect(row.kind).toBe('task-header');
    }

    const first = renderFeature(<ConversationRowView row={rows[0]!} lifecycle="live" />);
    expect(first.lastFrame() ?? '').toContain(LIVE_MARK);
    first.unmount();

    for (const row of rows.slice(1)) {
      const ui = renderFeature(<ConversationRowView row={row} lifecycle="live" />);
      const frame = ui.lastFrame() ?? '';
      expect(frame).not.toContain(LIVE_MARK);
      expect(frame).not.toContain(DONE_MARK);
      ui.unmount();
    }
  });
});

describe('taskStartedRowBlock continuations', () => {
  it('never starts a continuation with the break whitespace or a separator', () => {
    const rows = eventRows({
      event: makeTaskStart({
        taskId: taskId('T002'),
        index: 1,
        total: 4,
        title: 'Infer capabilities from the cloud model list',
        file: 'src/engine/providers/capability-inference.ts',
        action: 'modify',
        tool: 'claude-code',
        model: 'sonnet',
      }),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 60, viewportRows: 20, streaming },
    });

    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(1)) {
      const text = row.segments.map((segment) => segment.text).join('');
      expect(text).not.toMatch(/^\s/);
      expect(text).not.toMatch(/^·/);
    }
  });

  // The reproduction: at 120 columns the old space wrap broke `OpenCode CLI` after `OpenCode` and
  // stripped the leading separator, so the continuation opened with a bare `CLI · model`.
  it('keeps a multi-word tool label whole and strands no separator at the break', () => {
    const rows = eventRows({
      event: makeTaskStart({
        taskId: taskId('T901'),
        title: 'Project deterministic workflow activity',
        file: 'testing/visual/fixtures/workflow/projections.ts',
        action: 'modify',
        tool: 'opencode',
        model: 'openai/gpt-5.6-luna',
      }),
      globalIndex: 0,
      expanded: false,
      ctx: { width: 120, viewportRows: 20, streaming },
    });

    const lines = rows.map((row) => row.segments.map((segment) => segment.text).join(''));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((line) => line.includes('OpenCode CLI · GPT-5.6 Luna · via openai'))).toBe(
      true,
    );
    for (const line of lines) {
      expect(line.trimEnd()).not.toMatch(/·$/);
    }
    for (const line of lines.slice(1)) {
      expect(line).not.toMatch(/^\s*CLI\b/);
      expect(line).not.toMatch(/\bOpenCode\s*$/);
    }
  });

  const pathRows = (title: string, file: string, width: number) =>
    eventRows({
      event: makeTaskStart({
        taskId: taskId('T901'),
        title,
        file,
        files: [file, 'testing/visual/catalog.ts'],
        action: 'modify',
        tool: 'codex',
        model: 'gpt-5',
      }),
      globalIndex: 0,
      expanded: false,
      ctx: { width, viewportRows: 20, streaming },
    });
  const lineText = (row: { segments: readonly { text: string }[] }) =>
    row.segments.map((segment) => segment.text).join('');

  // The reproduction: at 60 columns the hard wrap filled the title row with `testing/vi` and left
  // `sual/fixtures/…` on the next row.
  it('breaks an over-long path at a slash and keeps each row on its own tone', () => {
    const rows = pathRows(
      'Project deterministic workflow activity',
      'testing/visual/fixtures/workflow/projections.ts',
      60,
    );

    expect(rows.map((row) => row.segments.map(({ text, tone }) => [text, tone]))).toEqual([
      [
        ['T901', 'text'],
        [' Project deterministic workflow activity', 'text'],
        [' ', 'textDim'],
      ],
      [['testing/visual/fixtures/workflow/', 'textDim']],
      [['projections.ts (modify) · +1 file', 'textDim']],
      [['OpenAI Codex CLI · GPT-5', 'implementer']],
    ]);
  });

  it('keeps a path that fits one row whole', () => {
    const lines = pathRows(
      'Project deterministic workflow activity',
      'testing/visual/fixtures/workflow/projections.ts',
      80,
    ).map((row) => lineText(row).trimEnd());

    expect(lines).toContain('testing/visual/fixtures/workflow/projections.ts (modify) · +1 file');
  });

  it('cuts a path segment wider than the row at the row width', () => {
    const name = `${'a'.repeat(70)}.ts`;
    const lines = pathRows('Short title', `src/${name}`, 60).map(lineText);
    const room = wrapWidthFor('task-header', 60) - 'src/'.length;

    expect(lines.slice(0, 3)).toEqual([
      'T901 Short title ',
      `src/${'a'.repeat(room)}`,
      `${'a'.repeat(70 - room)}.ts (modify) · +1 file`,
    ]);
  });

  it('starts a continuation on its text when the title fills the row exactly', () => {
    const wrapWidth = wrapWidthFor('task-header', 60);
    const title = 'a'.repeat(wrapWidth - 'T901 '.length);
    const rows = pathRows(title, 'src/a.ts', 60);

    expect(rows.map((row) => row.segments.map(({ text, tone }) => [text, tone]))).toEqual([
      [
        ['T901', 'text'],
        [` ${title}`, 'text'],
      ],
      [
        ['src/a.ts (modify) · +1 file', 'textDim'],
        [' · ', 'textDim'],
        ['OpenAI Codex CLI · GPT-5', 'implementer'],
      ],
    ]);
  });
});
