import { Box } from 'ink';
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { paint } from '../../core/theme/paint.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { defaultTheme } from '../theme.js';
import { Composer } from './view.js';

// The frames carry their SGR escapes only when chalk emits colour at all.
const originalForceColor = vi.hoisted(() => {
  const saved = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '3';
  return saved;
});

afterAll(() => {
  if (originalForceColor === undefined) delete process.env['FORCE_COLOR'];
  else process.env['FORCE_COLOR'] = originalForceColor;
});

const DRAFT_PATH =
  '.splitbrief/sessions/2026-10-22-add-a-greeting-helper-to-the-cli-entry-point-docs/draft.json';
const DRAFT_NOT_SAVED = `Draft not saved: permission denied · ${DRAFT_PATH} · quit again leaves without it`;
const CONFIG_EDIT_REFUSED =
  'SPLITBRIEF keeps the config it loaded before · Configuration errors in .splitbrief/config.yaml: planner.tool: Invalid option: expected one of "claude-code"|"codex"|"opencode"|"kilo-code"|"cursor"|"command-code"|"antigravity"';
const RECORD_NOT_READ =
  'Could not read the run record: the file ends before its last event · the run stays as it was · SPLITBRIEF reads the record again the next time the run opens · move the record aside to start over, or keep it and open the run later from the list';

/** The SGR parameters a run of text is painted with, read from the escape that opens it. */
function colorOf(frame: string, text: string): string | undefined {
  const before = frame.split(text)[0];
  return before?.split('\u001B[').at(-1)?.split('m')[0];
}

function inkOf(color: string | undefined): string | undefined {
  return colorOf(paint(color, 'x'), 'x');
}

/** A notice box: the tone frame, one padding cell each side, the glyph on the first row only. */
function framed(rows: readonly string[], lead: string, width: number): string[] {
  const inner = width - 4;
  return [
    `╭${'─'.repeat(width - 2)}╮`,
    ...rows.map((row, index) => {
      const text = `${index === 0 ? lead : ' '.repeat(lead.length)}${row}`;
      return `│ ${text.padEnd(inner)} │`;
    }),
    `╰${'─'.repeat(width - 2)}╯`,
  ];
}

/** The frame-drop form: tone bars at both edges, no top or bottom frame. */
function barred(rows: readonly string[], lead: string, width: number): string[] {
  const inner = width - 4;
  return rows.map((row, index) => {
    const text = `${index === 0 ? lead : ' '.repeat(lead.length)}${row}`;
    return `▌ ${text.padEnd(inner)} ▐`;
  });
}

// Home renders the composer in its body column; the column is the composer's own width.
function renderHome(cols: number, rows: number, width: number) {
  terminalSizeStore.__testReset({ cols, rows });
  const ui = renderFeature(
    <Box flexDirection="column" width={width}>
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint="Describe your feature…"
        homeHint="/help · /crew"
        width={width}
        onSubmit={() => {}}
        onRuntimeCommand={() => {}}
      />
    </Box>,
    { cols, rows },
  );
  onTestFinished(ui.unmount);
  return ui;
}

function plainRows(frame: string | undefined): string[] {
  return stripAnsiStyles(frame ?? '')
    .split('\n')
    .map((row) => row.trimEnd());
}

describe('Home notice above the composer', () => {
  beforeEach(() => {
    resetAllStores();
    forceUnicodeGlyphs();
  });

  it('centers a three-row error above the input, as wide as its widest row, at 120 columns', async () => {
    const ui = renderHome(120, 40, 108);
    await flushEffects();
    feedbackStore.setError(DRAFT_NOT_SAVED);
    await flushEffects();

    const rows = plainRows(ui.lastFrame());
    const top = rows.findIndex((row) => row.trimStart().startsWith('╭'));
    expect(rows.slice(top, top + 5).map((row) => row.trimStart())).toEqual(
      framed(
        ['Draft not saved: permission denied ·', `${DRAFT_PATH} ·`, 'quit again leaves without it'],
        '✗ ',
        100,
      ),
    );
    expect(rows[top]?.indexOf('╭')).toBe(4);
    expect(rows[top + 5]).toBe(`╭${'─'.repeat(106)}╮`);
  });

  it('counts the notice and its two frame rows in the dock Home plans its body around', async () => {
    const ui = renderHome(120, 40, 108);
    await flushEffects();
    feedbackStore.setError(DRAFT_NOT_SAVED);
    await flushEffects();

    expect(plainRows(ui.lastFrame()).some((row) => row.includes('Draft not saved'))).toBe(true);
    // Five notice rows over a one-row input box and its two borders.
    expect(inputHeightStore.get().rows).toBe(8);
  });

  it('paints an error frame and glyph in the error ink and its words in the text ink', async () => {
    const ui = renderHome(120, 40, 108);
    await flushEffects();
    feedbackStore.setError(DRAFT_NOT_SAVED);
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(colorOf(frame, '╭')).toBe(inkOf(defaultTheme.error));
    expect(colorOf(frame, '✗')).toBe(inkOf(defaultTheme.error));
    expect(colorOf(frame, 'Draft not saved')).toBe(inkOf(defaultTheme.text));
  });

  it('keeps a long path whole on one row and never breaks it inside a folder name at 60 columns', async () => {
    const ui = renderHome(60, 18, 56);
    await flushEffects();
    feedbackStore.setError(DRAFT_NOT_SAVED);
    await flushEffects();

    const rows = plainRows(ui.lastFrame());
    const top = rows.findIndex((row) => row.trimStart().startsWith('╭'));
    expect(rows.slice(top, top + 5).map((row) => row.trimStart())).toEqual(
      framed(
        [
          'Draft not saved: permission denied ·',
          '.splitbrief/…/draft.json ·',
          'quit again leaves without it',
        ],
        '✗ ',
        42,
      ),
    );
    expect(rows.join('\n')).not.toContain('add-a-gre');
  });

  it('drops the frame for a message that needs more rows than the Home budget leaves it', async () => {
    const ui = renderHome(60, 18, 56);
    await flushEffects();
    feedbackStore.setError(CONFIG_EDIT_REFUSED);
    await flushEffects();

    const rows = plainRows(ui.lastFrame());
    const first = rows.findIndex((row) => row.trimStart().startsWith('▌'));
    expect(rows.slice(first, first + 5).map((row) => row.trimStart())).toEqual(
      barred(
        [
          'SPLITBRIEF keeps the config it loaded before ·',
          'Configuration errors in .splitbrief/config.yaml:',
          'planner.tool: Invalid option: expected one of',
          '"claude-code"|"codex"|"opencode"|"kilo-code"|"cu',
          'rsor"|"command-code"|"antigravity"',
        ],
        '✗ ',
        54,
      ),
    );
    expect(rows[first]?.indexOf('▌')).toBe(1);
    expect(rows[first + 5]).toBe(`╭${'─'.repeat(54)}╮`);
    expect(inputHeightStore.get().rows).toBe(8);
  });

  it('cuts a message past the five-row budget at a word with an ellipsis', async () => {
    const ui = renderHome(60, 18, 56);
    await flushEffects();
    feedbackStore.setError(RECORD_NOT_READ);
    await flushEffects();

    const rows = plainRows(ui.lastFrame());
    const first = rows.findIndex((row) => row.trimStart().startsWith('▌'));
    expect(rows.slice(first, first + 6)).toEqual([
      ...barred(
        [
          'Could not read the run record: the file ends',
          'before its last event · the run stays as it was ·',
          'SPLITBRIEF reads the record again the next time',
          'the run opens · move the record aside to start',
          'over, or keep it and open the run later from the …',
        ],
        '✗ ',
        56,
      ),
      `╭${'─'.repeat(54)}╮`,
    ]);
  });

  it('frames a report in the border ink with no glyph and its words in the dim ink', async () => {
    const ui = renderHome(120, 40, 108);
    await flushEffects();
    feedbackStore.setInfo('Copied the brief to the clipboard');
    await flushEffects();

    const rows = plainRows(ui.lastFrame());
    const top = rows.findIndex((row) => row.trimStart().startsWith('╭'));
    expect(rows.slice(top, top + 3).map((row) => row.trimStart())).toEqual(
      framed(['Copied the brief to the clipboard'], '', 37),
    );
    const frame = ui.lastFrame() ?? '';
    expect(colorOf(frame, '╭')).toBe(inkOf(defaultTheme.border));
    expect(colorOf(frame, 'Copied the brief')).toBe(inkOf(defaultTheme.textDim));
  });
});
