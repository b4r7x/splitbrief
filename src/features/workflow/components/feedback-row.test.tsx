import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { openApprovalPrompt } from '../../../stores/approval-prompt/prompt.js';
import { REVIEW_HINT } from '../review-commands.js';
import { KEY_LEGEND_LEADING } from '../../../core/key-legend.js';
import { MARK_SLOT_CELLS } from '../../../components/row-leading.js';
import { formatCopyResult } from '../../../core/runtime/commands/types.js';
import { FeedbackRow, RUNNING_LEGEND } from './feedback-row.js';

describe('FeedbackRow', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('opens a message on the text column, leaving the mark slot empty', () => {
    feedbackStore.setMessage('Queued for PLAN · ctrl+⏎ sends now');

    const ui = renderFeature(<FeedbackRow />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    // The footer's gutter puts the row on column 1; the row insets itself by the mark slot so its
    // words land on the text column without putting a letter where a mark would stand.
    expect(frame.indexOf('Queued for PLAN')).toBe(MARK_SLOT_CELLS);

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
      feedbackStore.setMessage(formatCopyResult(outcome));
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
    lifecycleStore.__testReset({ status: 'running', phase: 'implementing' });

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

  it('renders an error as a leading state word plus a dim cause', () => {
    feedbackStore.setError('Failed planner timed out — press r to retry');

    const ui = renderFeature(<FeedbackRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('Failed');
    expect(frame).toContain('planner timed out — press r to retry');

    ui.unmount();
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
    feedbackStore.setMessage('Queued for PLAN · ctrl+⏎ sends now');

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
    lifecycleStore.__testReset({ status: 'running', phase: 'implementing' });
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
    feedbackStore.setMessage('Queued for PLAN · ctrl+⏎ sends now');
    const ui = renderFeature(<FeedbackRow panelBelow />);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('Queued for PLAN · ctrl+⏎ sends now');
    ui.unmount();
  });
});
