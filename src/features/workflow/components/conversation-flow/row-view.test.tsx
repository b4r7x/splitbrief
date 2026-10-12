import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box } from 'ink';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import type { ConversationRow } from '../../conversation-rows/types.js';
import { glyph } from '../../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../../utils/display-text.js';
import { defaultTheme, ThemeProvider, ThemeText as Text } from '../../../../components/theme.js';
import { resolveTheme } from '../../../../core/theme/resolve.js';
import { ConversationRowView } from './row-view.js';
import { eventRows } from '#testing/helpers/event-rows.js';
import { taskId } from '../../../../core/schemas/task.js';
import { rowLeading } from '../../conversation-rows/row-markers.js';

// Ink resolves chalk color level 0 against the capture stdout unless FORCE_COLOR is set before
// ink (and its chalk dependency) first load, so the background assertion below would silently
// no-op without this. Restored in afterAll so it never leaks into other test files.
const originalForceColor = vi.hoisted(() => {
  const saved = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '3';
  return saved;
});

afterAll(() => {
  if (originalForceColor === undefined) delete process.env['FORCE_COLOR'];
  else process.env['FORCE_COLOR'] = originalForceColor;
});

const DONE_MARK = glyph('stageDone');
const QUEUED_MARK = glyph('statusPending');
const LIVE_MARK = glyph('statusInProgress');
const FOCUS_MARK = glyph('liveBar');
const TREE_BRANCH_MARK = glyph('treeBranch');

function colorOpen(color: string | undefined): string {
  const ui = renderFeature(<Text color={color}>x</Text>);
  const frame = ui.lastFrame();
  ui.unmount();
  const prefix = frame.slice(0, frame.indexOf('x'));
  if (!prefix) throw new Error(`no color prefix rendered for ${color}`);
  return prefix;
}

function makeActivityRow(key: string): ConversationRow {
  return {
    key,
    kind: 'activity',
    segments: [{ text: 'reading src/a.ts', tone: 'textDim' }],
  };
}

function makeTaskHeaderRow(key: string): ConversationRow {
  return {
    key,
    kind: 'task-header',
    segments: [{ text: 'T001 No-op task', tone: 'text', bold: true }],
  };
}

describe('ConversationRowView lifecycle and focus glyphs', () => {
  it.each(['dark', 'light'] as const)(
    'renders explicit primary and secondary span colours in %s',
    (variant) => {
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      const row: ConversationRow = {
        key: 'explicit-tones',
        kind: 'message',
        segments: [
          { text: 'Primary', tone: 'text' },
          { text: ' secondary', tone: 'textDim' },
        ],
      };
      const ui = renderFeature(
        <ThemeProvider theme={theme}>
          <ConversationRowView row={row} />
        </ThemeProvider>,
      );
      expect(ui.lastFrame()).toContain(`${colorOpen(theme.text)}Primary`);
      expect(ui.lastFrame()).toContain(`${colorOpen(theme.textDim)} secondary`);
      ui.unmount();
    },
  );

  it.each(['dark', 'light'] as const)(
    'keeps an empty activity marker in the primary colour in %s',
    (variant) => {
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      const row: ConversationRow = { key: 'empty-activity', kind: 'activity', segments: [] };
      const ui = renderFeature(
        <ThemeProvider theme={theme}>
          <ConversationRowView row={row} />
        </ThemeProvider>,
      );
      expect(ui.lastFrame()).toContain(`${colorOpen(theme.text)}${rowLeading('activity', 'done')}`);
      ui.unmount();
    },
  );

  it('fits a long queued title beside its marker inside a narrow row', () => {
    const header = {
      ...makeTaskHeaderRow('queued-T007'),
      segments: [{ text: 'T007 Test overdue report boundaries', tone: 'textDim' as const }],
    };
    const ui = renderFeature(
      <Box width={21}>
        <ConversationRowView row={header} lifecycle="queued" />
      </Box>,
      { cols: 22, rows: 45 },
    );
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    expect(lines).toHaveLength(1);
    expect(getTerminalCellWidth(lines[0] ?? '')).toBeLessThanOrEqual(21);
    expect(lines[0]).toContain('T007');
    ui.unmount();
  });

  it('renders verified in success and its separator and explanation in textDim', () => {
    const rows = eventRows({
      event: {
        type: 'implementer_generate_done',
        ts: 0,
        phase: 'implementing',
        taskId: taskId('T001'),
        file: 'src/a.ts',
        duration: 1_000,
        noChange: true,
      },
      globalIndex: 0,
      expanded: false,
      ctx: { width: 80, viewportRows: 20, streaming: { taskId: null, lines: [], active: false } },
    });
    const row = rows.find((row) => row.segments.some((span) => span.text.includes('verified')));
    if (row === undefined) throw new Error('Missing verified row');
    const ui = renderFeature(<ConversationRowView row={row} />);
    expect(ui.lastFrame()).toContain(`${colorOpen(defaultTheme.success)}verified`);
    expect(ui.lastFrame()).toContain(`${colorOpen(defaultTheme.textDim)} · no change needed`);
    expect(stripAnsiStyles(ui.lastFrame())).toContain('verified · no change needed');
    ui.unmount();
  });
  it.each(['activity', 'task-header'] as const)(
    'pulses a live %s between accent and textDim',
    async (kind) => {
      const ui = renderFeature(
        <ConversationRowView
          row={{ key: 'pulse', kind, segments: [{ text: 'running', tone: 'textDim' }] }}
          lifecycle="live"
        />,
      );
      try {
        expect(ui.lastFrame().split(LIVE_MARK)[0]).toContain(colorOpen(defaultTheme.accent));
        await tick(650);
        expect(ui.lastFrame().split(LIVE_MARK)[0]).toContain(colorOpen(defaultTheme.textDim));
        await tick(500);
        expect(ui.lastFrame().split(LIVE_MARK)[0]).toContain(colorOpen(defaultTheme.accent));
      } finally {
        ui.unmount();
      }
    },
  );

  it('keeps queued marks dim and a settled mark in its recorded state tone', () => {
    const row: ConversationRow = {
      key: 'state',
      kind: 'activity',
      markerTone: 'error',
      segments: [{ text: 'BUILD activity', tone: 'implementer' }],
    };
    const queued = renderFeature(<ConversationRowView row={row} lifecycle="queued" />);
    expect(queued.lastFrame().split(QUEUED_MARK)[0]).toContain(colorOpen(defaultTheme.textDim));
    queued.unmount();
    const settled = renderFeature(<ConversationRowView row={row} lifecycle="done" />);
    expect(settled.lastFrame().split(DONE_MARK)[0]).toContain(colorOpen(defaultTheme.error));
    settled.unmount();
  });
  it('settles an activity row whose call a stop cut with the stop ×, not the done ●', () => {
    const row: ConversationRow = { ...makeActivityRow('activity-batch:0:cut'), interrupted: true };
    const settled = renderFeature(<ConversationRowView row={row} />);
    expect(settled.lastFrame()).toContain(glyph('statusCancelled'));
    expect(settled.lastFrame()).not.toContain(DONE_MARK);
    settled.unmount();
    const live = renderFeature(<ConversationRowView row={row} lifecycle="live" />);
    expect(live.lastFrame()).toContain(LIVE_MARK);
    live.unmount();
  });

  it('renders the live ◉ for an active activity row and the done ● for a finished one', () => {
    const activeRow = makeActivityRow('activity-batch:0:call-1');

    const active = renderFeature(<ConversationRowView row={activeRow} lifecycle="live" />);
    const activeFrame = active.lastFrame() ?? '';
    expect(activeFrame).toContain(LIVE_MARK);
    expect(activeFrame).not.toContain(DONE_MARK);
    expect(activeFrame).toContain('reading src/a.ts');
    active.unmount();

    const steady = renderFeature(<ConversationRowView row={activeRow} lifecycle="done" />);
    const steadyFrame = steady.lastFrame() ?? '';
    expect(steadyFrame).toContain(DONE_MARK);
    expect(steadyFrame).not.toContain(LIVE_MARK);
    expect(steadyFrame).toContain('reading src/a.ts');
    steady.unmount();
  });

  it('keeps the in-progress ◉ on a task-header row the pulse has moved past', () => {
    const row = makeTaskHeaderRow('task-header:T001');

    const active = renderFeature(<ConversationRowView row={row} lifecycle="live" />);
    const activeFrame = active.lastFrame() ?? '';
    expect(activeFrame).toContain(LIVE_MARK);
    expect(activeFrame).not.toContain(DONE_MARK);
    expect(activeFrame).toContain('T001 No-op task');
    active.unmount();

    const steady = renderFeature(<ConversationRowView row={row} lifecycle="active" />);
    const steadyFrame = steady.lastFrame() ?? '';
    expect(steadyFrame).toContain(LIVE_MARK);
    expect(steadyFrame).not.toContain(DONE_MARK);
    expect(steadyFrame).toContain('T001 No-op task');
    steady.unmount();

    const abandoned = renderFeature(<ConversationRowView row={row} lifecycle="done" />);
    expect(abandoned.lastFrame()).toContain(DONE_MARK);
    expect(abandoned.lastFrame()).not.toContain(LIVE_MARK);
    abandoned.unmount();
  });

  it.each([
    ['dark', 'active'],
    ['dark', 'done'],
    ['light', 'active'],
    ['light', 'done'],
  ] as const)(
    'paints the static task-header marker in text in %s during %s',
    (variant, lifecycle) => {
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      // Dim segment text isolates the marker's foreground.
      const row: ConversationRow = {
        key: 'task-header:T001',
        kind: 'task-header',
        segments: [{ text: 'T001 No-op task', tone: 'textDim' }],
      };

      const ui = renderFeature(
        <ThemeProvider theme={theme}>
          <ConversationRowView row={row} lifecycle={lifecycle} />
        </ThemeProvider>,
      );
      const frame = ui.lastFrame() ?? '';
      ui.unmount();

      expect(frame.split(LIVE_MARK)[0]).toContain(colorOpen(theme.text));
      expect(frame).not.toContain(colorOpen(theme.accent));
      expect(frame).not.toContain(colorOpen(theme.success));
    },
  );

  it.each(['dark', 'light'] as const)(
    'keeps the queued task-header marker dim in %s',
    (variant) => {
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      const ui = renderFeature(
        <ThemeProvider theme={theme}>
          <ConversationRowView row={makeTaskHeaderRow('task-header:T001')} lifecycle="queued" />
        </ThemeProvider>,
      );
      expect(ui.lastFrame().split(QUEUED_MARK)[0]).toContain(colorOpen(theme.textDim));
      ui.unmount();
    },
  );

  it('wears the ▌ accent bar on a focused transcript row', () => {
    const row = makeActivityRow('activity-batch:0:call-1');

    const focused = renderFeature(<ConversationRowView row={row} focused={true} />);
    const focusedFrame = focused.lastFrame() ?? '';
    expect(focusedFrame).toContain(FOCUS_MARK);
    expect(focusedFrame).toContain('reading src/a.ts');
    focused.unmount();

    const unfocused = renderFeature(<ConversationRowView row={row} focused={false} />);
    expect(unfocused.lastFrame() ?? '').not.toContain(FOCUS_MARK);
    unfocused.unmount();
  });

  // A focused task header does wear both marks (▌ ◉). This row is a live activity, where the
  // pulsing-dot branch preempts the focused branch, so the ◉ keeps the marker cell and the ▌ yields.
  it('keeps the pulsing live ◉ on its cell for a focused live activity row instead of the ▌ focus bar', () => {
    const row = makeActivityRow('activity-batch:0:call-1');

    const ui = renderFeature(<ConversationRowView row={row} lifecycle="live" focused={true} />);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(LIVE_MARK);
    expect(frame).not.toContain(FOCUS_MARK);
    ui.unmount();
  });

  it('does not blink rows whose marker is not the activity dot', () => {
    const row: ConversationRow = {
      key: 'activity-more:0:call-1-hidden',
      kind: 'activity-more',
      segments: [{ text: '+1 more', tone: 'textDim' }],
    };

    const ui = renderFeature(<ConversationRowView row={row} lifecycle="live" />);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('+1 more');
    expect(frame).not.toContain('└');
    expect(frame).not.toContain('▸');
    expect(frame).not.toContain(LIVE_MARK);
    ui.unmount();
  });

  it('renders a static active bullet without blinking under reduce-motion', async () => {
    process.env.SPLITBRIEF_REDUCE_MOTION = '1';
    try {
      const row = makeActivityRow('activity-batch:0:call-1');
      const ui = renderFeature(<ConversationRowView row={row} lifecycle="live" />);
      const framesBefore = ui.frames.length;

      await tick(650);

      expect(ui.frames).toHaveLength(framesBefore);
      expect(ui.lastFrame() ?? '').toContain(LIVE_MARK);
      ui.unmount();
    } finally {
      delete process.env.SPLITBRIEF_REDUCE_MOTION;
    }
  });

  it('paints the ▌ focus bar into the lead cell and keeps the header ◉ on the line beside it', () => {
    const row = makeTaskHeaderRow('task-header:T001');

    const ui = renderFeature(<ConversationRowView row={row} lifecycle="active" focused={true} />);
    const text = stripAnsiStyles(ui.lastFrame() ?? '');
    ui.unmount();

    const bar = text.indexOf(FOCUS_MARK);
    const marker = text.indexOf(LIVE_MARK);
    expect(bar).toBe(0);
    expect(marker).toBe(bar + 1);
    expect(text).not.toContain(DONE_MARK);
    expect(text).toContain('T001 No-op task');
  });

  it('keeps task-header row text aligned across focus changes', () => {
    const row = makeTaskHeaderRow('task-header:T001');
    const title = 'T001 No-op task';

    const focused = stripAnsiStyles(
      renderFeature(<ConversationRowView row={row} focused={true} />).lastFrame() ?? '',
    );
    const unfocused = stripAnsiStyles(
      renderFeature(<ConversationRowView row={row} focused={false} />).lastFrame() ?? '',
    );

    expect(focused.indexOf(title)).toBe(unfocused.indexOf(title));
    expect(focused.indexOf(title)).toBeGreaterThanOrEqual(0);
  });

  it('prepends the ▌ focus bar to a focused activity-child tree row', () => {
    const row: ConversationRow = {
      key: 'activity-child:0',
      kind: 'activity-child',
      segments: [{ text: 'reading src/b.ts', tone: 'textDim' }],
    };

    const ui = renderFeature(<ConversationRowView row={row} focused={true} />);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain(FOCUS_MARK);
    expect(frame).toContain(TREE_BRANCH_MARK);
    expect(frame).toContain('reading src/b.ts');
    ui.unmount();
  });
});

describe('ConversationRowView code background', () => {
  const codeRow: ConversationRow = {
    key: 'markdown-code-0',
    kind: 'message',
    segments: [
      { text: '▏ ', tone: 'markdownRule' },
      { text: "const x = 'y';", tone: 'markdownCode' },
    ],
    codeBg: true,
  };

  function backgroundOpen(color: string | undefined): string {
    const ui = renderFeature(
      <Box backgroundColor={color}>
        <Text>x</Text>
      </Box>,
    );
    const frame = ui.lastFrame();
    ui.unmount();
    const prefix = frame.slice(0, frame.indexOf('x'));
    if (!prefix) throw new Error(`no background prefix rendered for ${color}`);
    return prefix;
  }

  it('paints a code row with the themed background', () => {
    const theme = defaultTheme;
    const codeBg = theme.markdown.codeBg;
    if (codeBg === undefined) throw new Error('the theme must define markdown.codeBg');

    const ui = renderFeature(
      <ThemeProvider theme={theme}>
        <ConversationRowView row={codeRow} />
      </ThemeProvider>,
    );
    const frame = ui.lastFrame();

    expect(frame).toContain(backgroundOpen(codeBg));
    expect(stripAnsiStyles(frame)).toContain("▏ const x = 'y';");
    ui.unmount();
  });

  // A 16-color terminal has no background that frames code: the themed hex downsamples to
  // bgBlack, which is that terminal's own ground. resolveTheme hands such a terminal a preset
  // with no codeBg at all, and the rail has to carry the frame on its own.
  it('renders a code row unpainted on a terminal without hex color, leaving the rail to frame it', () => {
    const theme = resolveTheme({ variant: 'dark', level: 1, terminalBackground: undefined });
    const ui = renderFeature(
      <ThemeProvider theme={theme}>
        <ConversationRowView row={codeRow} />
      </ThemeProvider>,
    );
    const frame = ui.lastFrame();

    expect(theme.markdown.codeBg).toBeUndefined();
    expect(frame).not.toContain('\x1b[48;');
    expect(stripAnsiStyles(frame)).toContain("▏ const x = 'y';");
    ui.unmount();
  });

  it('leaves a row without the flag unpainted under the same theme', () => {
    const theme = defaultTheme;
    const plainRow: ConversationRow = {
      key: 'markdown-code-1',
      kind: 'message',
      segments: codeRow.segments,
    };
    const ui = renderFeature(
      <ThemeProvider theme={theme}>
        <ConversationRowView row={plainRow} />
      </ThemeProvider>,
    );
    const frame = ui.lastFrame();

    expect(frame).not.toContain('\x1b[48;');
    ui.unmount();
  });
});

describe('ConversationRowView color-off degradation', () => {
  beforeEach(() => {
    process.env.NO_COLOR = '1';
  });
  afterEach(() => {
    delete process.env.NO_COLOR;
  });

  it('keeps live, done, and queued header states distinct by glyph, not color', () => {
    const header = makeActivityRow('activity-batch:0:call-1');

    const live = renderFeature(<ConversationRowView row={header} lifecycle="live" />);
    const done = renderFeature(<ConversationRowView row={header} lifecycle="done" />);
    const queued = renderFeature(<ConversationRowView row={header} lifecycle="queued" />);

    expect(live.lastFrame() ?? '').toContain(LIVE_MARK);
    expect(done.lastFrame() ?? '').toContain(DONE_MARK);
    expect(queued.lastFrame() ?? '').toContain(QUEUED_MARK);

    live.unmount();
    done.unmount();
    queued.unmount();
  });

  it('carries focus emphasis with the ▌ glyph, never weight alone', () => {
    const row = makeTaskHeaderRow('task-header:T001');

    const focused = renderFeature(
      <ConversationRowView row={row} lifecycle="active" focused={true} />,
    );
    const focusedText = stripAnsiStyles(focused.lastFrame() ?? '');
    focused.unmount();

    expect(focusedText).toContain(FOCUS_MARK);
    expect(focusedText).not.toContain(DONE_MARK);
  });
});
