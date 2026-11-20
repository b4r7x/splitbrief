import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores, seedBriefs } from '#testing/helpers/stores.js';
import { defaultTheme } from '../../../components/theme.js';
import { paint } from '../../../core/theme/paint.js';
import { glyph, resolveGlyphTier } from '../../../lib/glyphs.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { openApprovalPrompt } from '../../../stores/prompts/approval.js';
import { questionPromptStore } from '../../../stores/prompts/question.js';
import { REVIEW_HINT } from '../review-gate/commands.js';
import { KEY_LEGEND_LEADING } from '../../../components/key-legend.js';
import { formatCopyResult } from '../../../core/runtime/commands/types.js';
import { clearAllHandlers } from '../run-requests/registry.js';
import { requestSeatChangeAtBoundary } from '../run-requests/boundary.js';
import { getChromeContentWidth, getChromeHeight } from '../layout/chrome-rows.js';
import { FeedbackRow, getFeedbackRows, RUNNING_LEGEND } from './feedback-row.js';

// The frames carry their SGR escapes only when chalk emits colour at all; a silent terminal would
// make every colour comparison agree by accident.
const originalForceColor = vi.hoisted(() => {
  const saved = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '3';
  return saved;
});

afterAll(() => {
  if (originalForceColor === undefined) delete process.env['FORCE_COLOR'];
  else process.env['FORCE_COLOR'] = originalForceColor;
});

/** The SGR parameters a run of text is painted with, read from the escape that opens it. */
function colorOf(frame: string, text: string): string | undefined {
  const before = frame.split(text)[0];
  return before?.split('\u001B[').at(-1)?.split('m')[0];
}

function inkOf(color: string | undefined): string | undefined {
  return colorOf(paint(color, 'x'), 'x');
}

// The test terminal is no TTY, so the frame and the bars take the tier this run resolves.
const UNICODE = resolveGlyphTier() === 'unicode';
const FRAME = UNICODE
  ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
  : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
const BARS = UNICODE ? { left: '▌', right: '▐' } : { left: '|', right: '|' };

/** A notice box: the tone frame, one padding cell each side, the glyph on the first row only. */
function framed(rows: readonly string[], lead: string, width: number): string[] {
  const inner = width - 4;
  return [
    `${FRAME.tl}${FRAME.h.repeat(width - 2)}${FRAME.tr}`,
    ...rows.map((row, index) => {
      const text = `${index === 0 ? lead : ' '.repeat(lead.length)}${row}`;
      return `${FRAME.v} ${text.padEnd(inner)} ${FRAME.v}`;
    }),
    `${FRAME.bl}${FRAME.h.repeat(width - 2)}${FRAME.br}`,
  ];
}

/** The frame-drop form: tone bars at both edges, no top or bottom frame. */
function barred(rows: readonly string[], lead: string, width: number): string[] {
  const inner = width - 4;
  return rows.map((row, index) => {
    const text = `${index === 0 ? lead : ' '.repeat(lead.length)}${row}`;
    return `${BARS.left} ${text.padEnd(inner)} ${BARS.right}`;
  });
}

function plainRows(frame: string | undefined): string[] {
  return stripAnsiStyles(frame ?? '')
    .split('\n')
    .map((row) => row.trimEnd());
}

it('gives the stop menu the legend row when it fills the body exactly', () => {
  const input = {
    feedback: { message: null, severity: 'info' } as const,
    terminalCols: 60,
    problem: null,
    maxRows: 3,
    inputRows: 3,
    stopMenuRows: 5,
  };
  const bodyRows = getChromeHeight(input.inputRows, 0) + input.stopMenuRows;
  expect(getFeedbackRows({ ...input, bodyRows: bodyRows - 1 })).toBe(1);
  expect(getFeedbackRows({ ...input, bodyRows })).toBe(0);
  expect(getFeedbackRows({ ...input, bodyRows: bodyRows + 1 })).toBe(1);
});

describe('FeedbackRow', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    clearAllHandlers();
    resetAllStores();
  });

  it('frames a one-row report on the composer edge, as wide as its words', () => {
    feedbackStore.setInfo('Queued for PLAN · ctrl+⏎ sends now');

    const ui = renderFeature(<FeedbackRow />);

    // The footer's gutter puts the row on the composer's left border; the box starts there.
    expect(plainRows(ui.lastFrame())).toEqual(
      framed(['Queued for PLAN · ctrl+⏎ sends now'], '', 38),
    );

    ui.unmount();
  });

  it('says nothing while a gate panel owns the legend', () => {
    controlsStore.setInputMode('review');

    const ui = renderFeature(<FeedbackRow inputHint={REVIEW_HINT} />);

    expect(stripAnsiStyles(ui.lastFrame() ?? '').trim()).toBe('');

    ui.unmount();
  });

  it.each(['native', 'tmux-buffer', 'osc52'] as const)(
    'shows the %s copy receipt beside a gate',
    (outcome) => {
      controlsStore.setInputMode('review');
      feedbackStore.setInfo(formatCopyResult(outcome));
      const ui = renderFeature(<FeedbackRow inputHint={REVIEW_HINT} />);
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(formatCopyResult(outcome));
      ui.unmount();
    },
  );

  it('says nothing while a tiered approval is pending', () => {
    void openApprovalPrompt({
      tier: 'confirm',
      actionClass: 'write_out_of_scope',
      actionDescription: 'write src/x.ts',
      phase: 'implementing',
    });

    const ui = renderFeature(<FeedbackRow inputHint="approve · ctrl+e/e edit" />);

    expect(stripAnsiStyles(ui.lastFrame() ?? '').trim()).toBe('');

    ui.unmount();
  });

  it('names the keys a running build answers to when nothing else owns the row', () => {
    runViewStore.__testReset({ phase: 'implementing' });
    lifecycleStore.__testReset({ status: 'running' });

    const ui = renderFeature(<FeedbackRow />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('esc stop options');
    expect(frame).toContain(RUNNING_LEGEND);
    // The legend carries the key mark, so its first key opens on the text column.
    expect(frame.startsWith(KEY_LEGEND_LEADING)).toBe(true);
    expect(frame.indexOf('esc stop options')).toBe(KEY_LEGEND_LEADING.length);

    ui.unmount();
  });

  it("marks a caller's key hint with the legend grammar, fitted to the legend budget", () => {
    const ui = renderFeature(
      <FeedbackRow keyHint="esc home · ctrl+k commands · /sessions · /help" />,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame.startsWith(KEY_LEGEND_LEADING)).toBe(true);
    expect(frame.indexOf('esc home')).toBe(KEY_LEGEND_LEADING.length);
    ui.unmount();

    terminalSizeStore.__testReset({ cols: 34, rows: 24, isSmall: false });
    const narrow = renderFeature(
      <FeedbackRow keyHint="esc home · ctrl+k commands · /sessions · /help" />,
    );
    const narrowFrame = stripAnsiStyles(narrow.lastFrame() ?? '');
    expect(narrowFrame.startsWith(KEY_LEGEND_LEADING)).toBe(true);
    expect(narrowFrame).not.toContain('…');
    narrow.unmount();
  });

  it('keeps review hints visible even while the composer is focused', () => {
    const ui = renderFeature(<FeedbackRow inputHint="approve · ctrl+e/e edit" />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('approve · ctrl+e/e edit');

    ui.unmount();
  });

  it('leads a failed connection hint with the error word and a dim cause', () => {
    const ui = renderFeature(
      <FeedbackRow inputHint="Failed server connection lost — ctrl+d to exit, retry with resume" />,
    );
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Failed');
    expect(frame).toContain('server connection lost — ctrl+d to exit, retry with resume');

    ui.unmount();
  });

  it('renders blank when the input hint is empty so the placeholder owns the hint', () => {
    const ui = renderFeature(<FeedbackRow inputHint="" />);
    const frame = ui.lastFrame() ?? '';

    expect(frame.trim()).toBe('');
    expect(frame).not.toContain('queue a message');

    ui.unmount();
  });

  it('renders the reconnecting connection hint as a single warning state word line', () => {
    const ui = renderFeature(<FeedbackRow inputHint="Reconnecting to server…" />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Reconnecting to server…');

    ui.unmount();
  });

  it('frames a failure with the failed mark and the frame in the error ink, the sentence in the text ink', () => {
    feedbackStore.setError('Draft not saved');

    const ui = renderFeature(<FeedbackRow />);
    const frame = ui.lastFrame() ?? '';

    expect(plainRows(frame)).toEqual(framed(['Draft not saved'], `${glyph('statusFailed')} `, 21));
    expect(colorOf(frame, FRAME.tl)).toBe(inkOf(defaultTheme.error));
    expect(colorOf(frame, glyph('statusFailed'))).toBe(inkOf(defaultTheme.error));
    expect(colorOf(frame, 'Draft not saved')).toBe(inkOf(defaultTheme.text));

    ui.unmount();
  });

  it('frames a report in the border ink with dim words and no glyph', () => {
    feedbackStore.setInfo('Nothing to steer.');

    const ui = renderFeature(<FeedbackRow />);
    const frame = ui.lastFrame() ?? '';

    expect(plainRows(frame)).toEqual(framed(['Nothing to steer.'], '', 21));
    expect(colorOf(frame, FRAME.tl)).toBe(inkOf(defaultTheme.border));
    expect(colorOf(frame, 'Nothing to steer.')).toBe(inkOf(defaultTheme.textDim));

    ui.unmount();
  });

  it('keeps a notice visible while a panel owns the keys', () => {
    feedbackStore.setInfo('Nothing to steer.');

    controlsStore.setInputMode('review');
    const review = renderFeature(<FeedbackRow inputHint={REVIEW_HINT} />);
    expect(plainRows(review.lastFrame())).toEqual(framed(['Nothing to steer.'], '', 21));
    review.unmount();

    controlsStore.setInputMode('question');
    questionPromptStore.setQuestions([
      { id: 'module', type: 'choice', text: 'Which module?', options: ['a', 'b'] },
    ]);
    const question = renderFeature(<FeedbackRow inputHint="Type your answer…" />);
    expect(plainRows(question.lastFrame())).toEqual(framed(['Nothing to steer.'], '', 21));
    question.unmount();
  });

  it('summarizes and sanitizes multiline prompt hints', () => {
    const rawToken = 'abcdefghijklmnopqrstuvwxyz1234567890abcdef';
    const ui = renderFeature(
      <FeedbackRow
        inputHint={[
          `Task review: token=${rawToken}\u001b]52;c;clipboard\u0007`,
          'Commands: continue, abort',
        ].join('\n')}
      />,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Task review: token=***REDACTED***');
    expect(frame).not.toContain('Commands: continue');
    expect(frame).not.toContain(rawToken);
    expect(frame).not.toContain('clipboard');
    expect(frame).not.toContain('\u001b');

    ui.unmount();
  });

  it('lets live feedback own the row instead of gluing the hint after it', () => {
    feedbackStore.setInfo('Queued for PLAN · ctrl+⏎ sends now');

    const ui = renderFeature(<FeedbackRow inputHint="approve · ctrl+e/e edit" />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Queued for PLAN · ctrl+⏎ sends now');
    expect(frame).not.toContain('approve · ctrl+e/e edit');

    ui.unmount();
  });

  it('never renders an editor failure run-on with the review key legend', () => {
    feedbackStore.setError('Failed to open editor (vi): spawn vi ENOENT');

    const ui = renderFeature(<FeedbackRow inputHint={REVIEW_HINT} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Failed to open editor (vi): spawn vi ENOENT');
    expect(frame).not.toContain('approve · comment');

    ui.unmount();
  });

  it('restores the review key legend once the feedback clears', () => {
    feedbackStore.setError('Failed to open editor (vi): spawn vi ENOENT');
    feedbackStore.setError(null);

    const ui = renderFeature(<FeedbackRow inputHint={REVIEW_HINT} />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('approve · comment');
    expect(frame).not.toContain('Failed to open editor');

    ui.unmount();
  });

  // The sheet under the row is the panel that owns the footer, so a row with nothing to say must
  // not leave its reserved blank line behind.
  it('drops its empty slot when a panel under it owns the footer', () => {
    const ui = renderFeature(
      <>
        <Text>above</Text>
        <FeedbackRow panelBelow />
        <Text>below</Text>
      </>,
    );
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');

    expect(lines).toEqual(['above', 'below']);
    ui.unmount();
  });

  // The stop sheet names its own keys; the run's legend above it would offer `esc stop options`
  // for a sheet that is already open.
  it('leaves the legend to a panel under it', () => {
    runViewStore.__testReset({ phase: 'implementing' });
    lifecycleStore.__testReset({ status: 'running' });
    const ui = renderFeature(
      <>
        <Text>above</Text>
        <FeedbackRow panelBelow />
        <Text>below</Text>
      </>,
    );
    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');

    expect(lines).toEqual(['above', 'below']);
    ui.unmount();
  });

  it('keeps the row when a message resolves above a panel that owns the footer', () => {
    feedbackStore.setInfo('Queued for PLAN · ctrl+⏎ sends now');
    const ui = renderFeature(<FeedbackRow panelBelow />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Queued for PLAN · ctrl+⏎ sends now');
    ui.unmount();
  });

  it('names when a saved seat changes, and keeps the keys a running build answers to', () => {
    terminalSizeStore.__testReset({ cols: 120, rows: 24, isSmall: false });
    runViewStore.__testReset({ phase: 'implementing' });
    lifecycleStore.__testReset({ status: 'running' });
    seedBriefs({
      tasks: [{ id: 'T001', title: 'first', status: 'in_progress' }],
      currentTask: 1,
      totalTasks: 1,
    });
    requestSeatChangeAtBoundary();

    const ui = renderFeature(<FeedbackRow />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame.trim()).toBe(`${KEY_LEGEND_LEADING}Seat changes after T001 · ${RUNNING_LEGEND}`);
    expect(frame).not.toContain('Pause requested');
    ui.unmount();
  });

  const RUN_LOCK_RELEASE = `Could not release the run lock: permission denied · .splitbrief/sessions/2026-10-23-create-src-kebab-js-commonjs-exporting-kebab-text-/lockfile.json · other SPLITBRIEF processes can see the run as running for a few more seconds`;

  function renderRunLockRelease(cols: number): string[] {
    terminalSizeStore.__testReset({ cols, rows: 24, isSmall: false });
    feedbackStore.setError(RUN_LOCK_RELEASE);

    const ui = renderFeature(<FeedbackRow />, { cols: getChromeContentWidth(cols), rows: 24 });
    const rows = plainRows(ui.lastFrame());
    ui.unmount();
    return rows;
  }

  const FAILED = `${glyph('statusFailed')} `;

  // Three rows are the whole workflow budget: a frame would take two more, so the frame drops.
  it('shows a long run lock message whole on three bar rows at 120 columns', () => {
    expect(renderRunLockRelease(120)).toEqual(
      barred(
        [
          'Could not release the run lock: permission denied ·',
          '.splitbrief/sessions/2026-10-23-create-src-kebab-js-commonjs-exporting-kebab-text-/lockfile.json ·',
          'other SPLITBRIEF processes can see the run as running for a few more seconds',
        ],
        FAILED,
        104,
      ),
    );
  });

  it('keeps the lock file name and the full message on three rows at 80 columns', () => {
    const rows = renderRunLockRelease(80);
    expect(rows).toHaveLength(3);
    expect(
      rows
        .map((row) => row.slice(BARS.left.length + 1 + FAILED.length, -BARS.right.length).trim())
        .join(' '),
    ).toBe(
      RUN_LOCK_RELEASE.replace(
        /\.splitbrief\/sessions\/[^/]+\/lockfile\.json/u,
        '.splitbrief/…/lockfile.json',
      ),
    );
  });

  it('keeps the lock file name and its first folder whole, never a broken folder name, at 60 columns', () => {
    expect(renderRunLockRelease(60)).toEqual(
      barred(
        [
          'Could not release the run lock: permission denied ·',
          '.splitbrief/…/lockfile.json ·',
          'other SPLITBRIEF processes can see the run as …',
        ],
        FAILED,
        57,
      ),
    );
  });

  it('shows a failure too long for one row whole on the bar rows it needs at 80 columns', () => {
    const reason =
      'This run started in /Users/me/projects/shop. Move the project back to that folder and start SPLITBRIEF there to continue the run, or end the run.';
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
    feedbackStore.setError(reason);

    const ui = renderFeature(<FeedbackRow />, { cols: getChromeContentWidth(80), rows: 24 });
    const rows = plainRows(ui.lastFrame());
    ui.unmount();

    expect(rows).toEqual(
      barred(
        [
          'This run started in /Users/me/projects/shop. Move',
          'the project back to that folder and start SPLITBRIEF',
          'there to continue the run, or end the run.',
        ],
        FAILED,
        58,
      ),
    );
  });

  it('shows the running legend after Esc closes a planner question', () => {
    runViewStore.__testReset({ phase: 'planning' });
    lifecycleStore.__testReset({ status: 'running' });
    controlsStore.setInputMode('question');
    questionPromptStore.setQuestions([
      { id: 'module', type: 'choice', text: 'Which module?', options: ['a', 'b'] },
    ]);
    questionPromptStore.close();

    const ui = renderFeature(<FeedbackRow inputHint="Type your answer…" />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('esc stop options');
    expect(frame.startsWith(KEY_LEGEND_LEADING)).toBe(true);
    expect(frame).not.toContain('Type your answer');

    ui.unmount();
  });

  it('shows the running legend after Esc closes a reviewer question', () => {
    runViewStore.__testReset({ phase: 'final-review' });
    lifecycleStore.__testReset({ status: 'running' });
    controlsStore.setInputMode('question');
    questionPromptStore.setQuestions([
      { id: 'module', type: 'choice', text: 'Which module?', options: ['a', 'b'] },
    ]);
    questionPromptStore.close();

    const ui = renderFeature(<FeedbackRow inputHint="Reply to the planner…" />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('esc stop options');
    expect(frame.startsWith(KEY_LEGEND_LEADING)).toBe(true);
    expect(frame).not.toContain('Reply to the planner');

    ui.unmount();
  });

  it('shows the running legend while waiting for an ordinary prose planner reply', () => {
    runViewStore.__testReset({ phase: 'planning' });
    lifecycleStore.__testReset({ status: 'running' });
    controlsStore.setInputMode('question');
    questionPromptStore.setQuestions([]);

    const ui = renderFeature(<FeedbackRow inputHint="Reply to the planner…" />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('esc stop options');
    expect(frame.startsWith(KEY_LEGEND_LEADING)).toBe(true);
    expect(frame).not.toContain('Reply to the planner');

    ui.unmount();
  });

  it('stays blank while a structured question panel is open', () => {
    runViewStore.__testReset({ phase: 'planning' });
    lifecycleStore.__testReset({ status: 'running' });
    controlsStore.setInputMode('question');
    questionPromptStore.setQuestions([
      { id: 'module', type: 'choice', text: 'Which module?', options: ['a', 'b'] },
    ]);

    const ui = renderFeature(<FeedbackRow inputHint="Type your answer…" />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame.trim()).toBe('');

    ui.unmount();
  });

  it('stays blank while a recovery panel is up', () => {
    runViewStore.__testReset({ phase: 'planning' });
    lifecycleStore.__testReset({ status: 'running' });
    controlsStore.setInputMode('question');

    const ui = renderFeature(<FeedbackRow inputHint="Type your answer…" />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame.trim()).toBe('');

    ui.unmount();
  });

  it("shows the caller's key legend at rest", () => {
    controlsStore.setInputMode('normal');

    const ui = renderFeature(
      <FeedbackRow keyHint="esc home · ctrl+k commands · /sessions · /help" />,
    );
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('esc home');

    ui.unmount();
  });

  it('keeps whole keys and no ellipsis at 60 columns in prose-reply state', () => {
    terminalSizeStore.__testReset({ cols: 60, rows: 18, isSmall: false });
    runViewStore.__testReset({ phase: 'planning' });
    lifecycleStore.__testReset({ status: 'running' });
    controlsStore.setInputMode('question');
    questionPromptStore.setQuestions([]);

    const ui = renderFeature(<FeedbackRow inputHint="Reply to the planner…" />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame.startsWith(KEY_LEGEND_LEADING)).toBe(true);
    expect(frame).toContain('esc stop options');
    expect(frame).not.toContain('…');

    ui.unmount();
  });
});
